/**
 * PromaMcpServer — 面向 ChatGPT Web 等外部 MCP Client 的本地能力服务器
 * （第二轮：一个 MCP Gateway 管理多个 Workspace）
 *
 * - Streamable HTTP（POST /mcp 初始化与会话内调用；GET/DELETE 管理 SSE 与关闭）；
 * - endpoint 路由：/mcp = 全部已启用 Workspace；/mcp/<profileId> = Connection Profile 子集；
 * - 默认仅监听 127.0.0.1；会话按 Mcp-Session-Id 管理，空闲 30 分钟回收；
 * - 工具经 McpToolAdapter 过滤暴露；每次调用显式解析 workspace（无全局 activeWorkspace）；
 * - 工具执行不触碰 Pi / Codex / 任何模型调用（架构隔离硬约束）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node'
import { normalizePromaMcpServerConfig } from './config'
import { buildMcpToolViews, visibleToolNames } from './tool-adapter'
import { isRequestAuthorized } from './auth'
import { captureRpcResponse, extractSafeRequestMetadata } from './protocol/request-trace'
import { createModernServer, MCP_SERVER_INFO, MODERN_PROTOCOL_VERSION, type McpToolHandlers } from './protocol/modern-server'
import { LegacyMcpServer } from './protocol/legacy-server'
import { usesLegacyProtocol } from './protocol/protocol-router'
import { classifyRequest, readRequestBody } from './protocol/request-classifier'
import {
  resolveTargetWorkspace,
  assertToolPermission,
  handleWorkspaceList,
  handleReadMany,
  handleGitStatusBatch,
  handleCrossWorkspaceSearch,
  type WorkspaceDirectoryEntry,
  type WorkspaceContextResolver,
} from './multi-workspace'
import type { PromaMcpRequestTrace, PromaMcpServerConfig, PromaMcpServerStatus } from '@proma/shared'
import type { LocalToolRegistry, LocalToolContext, LocalToolResult } from '../local-tools'

const validateHost = localhostHostValidation()
const validateOrigin = localhostOriginValidation()

interface StartInput {
  config: PromaMcpServerConfig
  /** 启动时列出全部已注册 Workspace（含未启用，供状态展示） */
  listWorkspaces(): WorkspaceDirectoryEntry[]
  /** 调用时解析某个 Workspace 的执行上下文（rootPath 每次调用时重新验证） */
  resolveWorkspaceContext(entryId: string): { context: LocalToolContext; entry: WorkspaceDirectoryEntry } | { error: string }
  registry: LocalToolRegistry
  /** 解析 Local MCP 生效的 Bearer token（managed-bearer → safeStorage；bearer → 配置；none → undefined） */
  resolveAuthToken(): string | undefined
}

export class PromaMcpServer {
  private httpServer: ReturnType<typeof createServer> | null = null
  private legacy = new LegacyMcpServer()
  private readonly modern = new Map<string, ReturnType<typeof createModernServer>>()
  private debugStartedAt = 0
  private debugUntil = 0
  private config: PromaMcpServerConfig | null = null
  private listWorkspaces: (() => WorkspaceDirectoryEntry[]) | null = null
  private resolveWorkspaceContext: StartInput['resolveWorkspaceContext'] | null = null
  private resolveAuthToken: StartInput['resolveAuthToken'] | null = null
  private registry: LocalToolRegistry | null = null
  private lastError: string | undefined
  private lastToolCall: { name: string; at: number } | undefined
  /** 最近 MCP 请求观测（环形缓冲，V5 §10） */
  private readonly requestTraces: PromaMcpRequestTrace[] = []

  get running(): boolean {
    return this.httpServer !== null
  }

  async start(input: StartInput): Promise<PromaMcpServerStatus> {
    await this.stop()
    this.legacy = new LegacyMcpServer()
    this.requestTraces.length = 0
    const config = normalizePromaMcpServerConfig(input.config)
    this.config = config
    this.listWorkspaces = input.listWorkspaces
    this.resolveWorkspaceContext = input.resolveWorkspaceContext
    this.resolveAuthToken = input.resolveAuthToken
    this.registry = input.registry

    const host = config.host
    const requestedPort = config.port === 'auto' ? 0 : config.port

    const httpServer = createServer((req, res) => { void this.route(req, res) })
    this.httpServer = httpServer

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => { this.httpServer = null; reject(err) }
      httpServer.once('error', onError)
      httpServer.listen(requestedPort, host, () => {
        httpServer.off('error', onError)
        resolve()
      })
    })

    const address = httpServer.address()
    const port = typeof address === 'object' && address ? address.port : requestedPort
    return this.getStatus(port)
  }

  async stop(): Promise<void> {
    await this.legacy.close()
    await Promise.all([...this.modern.values()].map((handler) => handler.close()))
    this.modern.clear()
    const server = this.httpServer
    this.httpServer = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  getStatus(portOverride?: number): PromaMcpServerStatus {
    const server = this.httpServer
    const address = server?.address()
    const port = portOverride ?? (typeof address === 'object' && address ? address.port : (this.config?.port === 'auto' ? 0 : this.config?.port ?? 0))
    const host = this.config?.host ?? '127.0.0.1'
    const entries = this.listWorkspaces?.() ?? []
    const summaries = entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      enabled: entry.enabled,
      available: entry.enabled,
      permissions: entry.permissions,
    }))
    const profileEndpoints = (this.config?.profiles ?? [])
      .filter((profile) => profile.enabled && server !== null)
      .map((profile) => ({ id: profile.id, name: profile.name, endpoint: 'http://' + host + ':' + port + '/mcp/' + profile.id }))
    return {
      running: server !== null,
      host,
      port,
      endpoint: server !== null ? 'http://' + host + ':' + port + '/mcp' : '',
      activeSessions: this.legacy.sessions.size,
      appVersion: MCP_SERVER_INFO.version,
      mcpProtocolVersion: MODERN_PROTOCOL_VERSION,
      protocolDebug: { startedAt: this.debugStartedAt, expiresAt: this.debugUntil, active: Date.now() < this.debugUntil },
      workspaces: summaries,
      profileEndpoints,
      ...(this.lastToolCall ? { lastToolCall: this.lastToolCall } : {}),
      recentRequests: [...this.requestTraces],
      ...(this.lastError ? { errorMessage: this.lastError } : {}),
    }
  }

  /** 记录一条请求观测（不含 Authorization / Runtime Key / 工具参数） */
  private recordRequest(trace: PromaMcpRequestTrace): void {
    this.requestTraces.push(trace)
    if (this.requestTraces.length > 500) this.requestTraces.shift()
  }

  startProtocolDebug(): PromaMcpServerStatus {
    this.debugStartedAt = Date.now()
    this.debugUntil = this.debugStartedAt + 120_000
    this.requestTraces.length = 0
    return this.getStatus()
  }

  /** 解析 endpoint 作用域：/mcp = 全部；/mcp/<profileId> = Profile 子集。未知 Profile 返回 undefined。 */
  private resolveEndpointScope(url: string): { profileId?: string; ok: boolean } {
    const path = url.split('?')[0] ?? ''
    if (path === '/mcp' || path === '/mcp/') return { ok: true }
    const match = /^[/]mcp[/]([^/]+)$/.exec(path)
    if (!match) return { ok: false }
    const profileId = decodeURIComponent(match[1]!)
    const profile = this.config?.profiles.find((p) => p.id === profileId && p.enabled)
    if (!profile) return { ok: false }
    return { profileId: profile.id, ok: true }
  }

  /** Profile 作用域下的可见 Workspace（/mcp 全部启用；profile 取交集） */
  private scopedEntries(profileId?: string): WorkspaceDirectoryEntry[] {
    const all = (this.listWorkspaces?.() ?? []).filter((e) => e.enabled)
    if (!profileId) return all
    const profile = this.config?.profiles.find((p) => p.id === profileId && p.enabled)
    if (!profile) return []
    return all.filter((entry) => profile.workspaceIds.includes(entry.id))
  }

  private toolHandlers(profileId?: string): McpToolHandlers {
    return {
      list: () => this.config && this.registry ? buildMcpToolViews(this.config, this.registry) : [],
      call: async (name, args) => {
        if (!this.registry || !this.config || !this.resolveWorkspaceContext) throw new Error('MCP 未运行')
        const result: LocalToolResult = visibleToolNames(this.config, this.registry).has(name)
          ? await this.dispatchToolCall(name, args, profileId, this.resolveWorkspaceContext, this.registry)
          : { ok: false, error: { code: 'PERMISSION_DENIED', message: '工具未启用' } }
        this.lastToolCall = { name, at: Date.now() }
        return {
          content: [{ type: 'text', text: result.text ?? JSON.stringify(result.ok ? result.data ?? {} : result.error) }],
          ...(result.ok && result.data ? { structuredContent: result.data } : {}),
          isError: !result.ok,
        }
      },
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const trace: PromaMcpRequestTrace = {
      requestKind: 'unknown-http', requestSource: 'unknown',
      at: Date.now(), method: req.method ?? '', path: '/mcp/unknown',
      hasSessionId: typeof req.headers['mcp-session-id'] === 'string', statusCode: 0,
      authResult: 'not-required',
      ...(Date.now() < this.debugUntil ? { requestMetadata: extractSafeRequestMetadata(req.headers) } : {}),
    }
    const response = captureRpcResponse(res)
    let recorded = false
    const finish = (): void => {
      if (recorded) return
      recorded = true
      const sessionEvent = res.getHeader('mcp-session-id') ? 'created'
        : trace.hasSessionId && res.statusCode < 400 ? (req.method === 'DELETE' ? 'closed' : 'used') : undefined
      this.recordRequest({ ...trace, ...response(), statusCode: res.statusCode, completed: res.writableFinished, ...(sessionEvent ? { sessionEvent } : {}) })
    }
    res.once('finish', finish)
    res.once('close', finish)
    try {
      const config = this.config
      if (!config || !this.httpServer) { res.writeHead(503).end(); return }
      if (!validateHost(req, res) || !validateOrigin(req, res)) { trace.authResult = 'rejected'; return }
      const url = req.url ?? ''
      const path = url.split('?')[0] ?? ''
      const setClassification = (parsedBody?: Awaited<ReturnType<typeof readRequestBody>>): void => {
        const classified = classifyRequest({ method: req.method ?? '', path, headers: req.headers, parsedBody, hasMcpSessionId: trace.hasSessionId })
        trace.requestKind = classified.kind
        trace.requestSource = classified.source
        trace.sourceSignals = classified.signals
      }
      setClassification()
      if (url.split('?')[0] === '/health') {
        trace.path = '/health'
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...MCP_SERVER_INFO, status: 'ok' }))
        return
      }
      if (trace.requestKind === 'oauth-well-known') {
        trace.path = path.replace(/(\/mcp)\/[^/]+\/?$/, '$1/:profile')
        res.writeHead(404).end()
        return
      }
      const scope = this.resolveEndpointScope(url)
      if (!scope.ok) { res.writeHead(404).end(); return }
      trace.path = scope.profileId ? '/mcp/' + scope.profileId : '/mcp'
      // 先识别有限大小的 body，认证拒绝的真实 RPC 也能正确归因；未经认证绝不调用工具。
      const parsedBody = req.method === 'POST' ? await readRequestBody(req) : undefined
      setClassification(parsedBody)
      const body = parsedBody?.kind === 'json' ? parsedBody.value : undefined
      if (trace.requestKind === 'mcp-rpc' && Array.isArray(body)) {
        // 一次 HTTP 只记一个 trace；旧 batch 不作为 modern Discovery 就绪证据。
        trace.jsonRpcMethod = '(batch)'
      } else if (trace.requestKind === 'mcp-rpc') {
        const rpc = body as { method: string; params?: { protocolVersion?: unknown; _meta?: Record<string, unknown> } }
        trace.jsonRpcMethod = rpc.method.slice(0, 100)
        const version = rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'] ?? req.headers['mcp-protocol-version'] ?? rpc.params?.protocolVersion
        trace.protocolVersion = typeof version === 'string' ? version.slice(0, 40) : undefined
      }
      if (config.auth.type !== 'none') {
        trace.authResult = 'rejected'
        if (!isRequestAuthorized(config.auth, this.resolveAuthToken?.(), req.headers.authorization)) {
          res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        trace.authResult = 'accepted'
      }
      if (trace.requestKind === 'oauth-probe' && req.method === 'POST') {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'MCP request body required' }))
        return
      }
      if (trace.requestKind === 'legacy-session-stream') {
        trace.protocolEra = 'legacy'
        await this.legacy.handle(req, res, body, scope.profileId, this.toolHandlers(scope.profileId))
        return
      }
      if (trace.requestKind !== 'mcp-rpc') {
        if (req.method !== 'POST') res.writeHead(405, { allow: 'POST' }).end()
        else res.writeHead(parsedBody?.kind === 'too-large' ? 413 : 400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: {
          code: parsedBody?.kind === 'invalid-json' ? -32700 : -32600,
          message: parsedBody?.kind === 'too-large' ? 'MCP body too large' : parsedBody?.kind === 'invalid-json' ? 'Invalid JSON' : 'MCP JSON-RPC request required',
        } }))
        return
      }
      const legacy = await usesLegacyProtocol(req, body)
      trace.protocolEra = legacy ? 'legacy' : 'modern'
      if (legacy) {
        await this.legacy.handle(req, res, body, scope.profileId, this.toolHandlers(scope.profileId))
      } else {
        const key = scope.profileId ?? ''
        let handler = this.modern.get(key)
        if (!handler) { handler = createModernServer(this.toolHandlers(scope.profileId)); this.modern.set(key, handler) }
        await handler.handle(req, res, body)
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal MCP error' } }))
      } else if (!res.writableEnded) res.end()
    }
  }

  /** 统一工具分发：多工作区固定工具 + 单工作区工具（显式解析 workspace、按仓库权限放行） */
  private async dispatchToolCall(
    name: string,
    args: Record<string, unknown>,
    profileId: string | undefined,
    resolveContext: StartInput['resolveWorkspaceContext'],
    registry: LocalToolRegistry,
  ): Promise<LocalToolResult> {
    const entries = this.scopedEntries(profileId)
    const scopedResolver: WorkspaceContextResolver = (entryId: string) => {
      if (!entries.some((e) => e.id === entryId)) return { error: 'workspace 不在当前 endpoint 的授权范围内' }
      return resolveContext(entryId)
    }

    if (name === 'workspace_list') return handleWorkspaceList(entries)
    if (name === 'read_many') return handleReadMany(args, entries, scopedResolver, registry)
    if (name === 'git_status_batch') return handleGitStatusBatch(args, entries, scopedResolver, registry)
    if (name === 'search_text' && Array.isArray(args.workspace_ids) && args.workspace_ids.length > 0) {
      return handleCrossWorkspaceSearch(args, entries, scopedResolver, registry)
    }

    const definition = registry.get(name)
    if (!definition) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: '未知工具: ' + name } }
    }
    this.lastToolCall = { name, at: Date.now() }
    const resolved = resolveTargetWorkspace(args.workspace_id, entries)
    if ('error' in resolved) return { ok: false, error: resolved.error }
    const permissionError = assertToolPermission(definition.risk, resolved.entry.permissions)
    if (permissionError) return { ok: false, error: permissionError }
    const ctx = scopedResolver(resolved.entry.id)
    if ('error' in ctx) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: ctx.error } }
    }
    // workspace_id 是网关层参数，不透传给工具实现
    const toolArgs: Record<string, unknown> = { ...args }
    delete toolArgs.workspace_id
    delete toolArgs.workspace_ids
    return definition.execute(toolArgs, ctx.context)
  }
}
