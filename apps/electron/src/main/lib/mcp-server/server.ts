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
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { normalizePromaMcpServerConfig } from './config'
import { buildMcpToolViews } from './tool-adapter'
import { SessionManager } from './session-manager'
import { isRequestAuthorized } from './auth'
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

const IDLE_TTL_MS = 30 * 60 * 1000

interface StartInput {
  config: PromaMcpServerConfig
  /** 启动时列出全部已注册 Workspace（含未启用，供状态展示） */
  listWorkspaces(): WorkspaceDirectoryEntry[]
  /** 调用时解析某个 Workspace 的执行上下文（rootPath 每次调用时重新验证） */
  resolveWorkspaceContext(entryId: string): { context: LocalToolContext; entry: WorkspaceDirectoryEntry } | { error: string }
  registry: LocalToolRegistry
}

export class PromaMcpServer {
  private httpServer: ReturnType<typeof createServer> | null = null
  private readonly sessions = new SessionManager()
  private config: PromaMcpServerConfig | null = null
  private listWorkspaces: (() => WorkspaceDirectoryEntry[]) | null = null
  private resolveWorkspaceContext: StartInput['resolveWorkspaceContext'] | null = null
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
    const config = normalizePromaMcpServerConfig(input.config)
    this.config = config
    this.listWorkspaces = input.listWorkspaces
    this.resolveWorkspaceContext = input.resolveWorkspaceContext
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
    this.sessions.startIdleSweep((sessionId) => { void this.closeSession(sessionId) }, IDLE_TTL_MS)
    return this.getStatus(port)
  }

  async stop(): Promise<void> {
    this.sessions.closeAll()
    const server = this.httpServer
    this.httpServer = null
    this.sessions.stopIdleSweep()
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
      activeSessions: this.sessions.size,
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
    if (this.requestTraces.length > 50) this.requestTraces.shift()
  }

  private async closeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    this.sessions.delete(sessionId)
    try { await entry.transport.close() } catch { /* 已关闭 */ }
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

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? ''
    const config = this.config
    if (!config || !this.httpServer) {
      res.writeHead(503).end()
      return
    }

    if (url === '/health' || url.startsWith('/health?')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'Proma MCP', status: 'ok' }))
      return
    }

    const scope = this.resolveEndpointScope(url)
    if (!scope.ok) {
      res.writeHead(404).end()
      return
    }

    if (!isRequestAuthorized(config.auth, req.headers.authorization)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id']
      if (typeof sessionId === 'string') await this.closeSession(sessionId)
      res.writeHead(200).end()
      return
    }

    if (req.method !== 'POST' && req.method !== 'GET') {
      res.writeHead(405, { allow: 'POST, GET, DELETE' }).end()
      return
    }

    const sessionHeader = req.headers['mcp-session-id']
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined

    if (req.method === 'POST') {
      // V5 §10：在路由层读取并观测请求（只记录 method / path / session 有无 / JSON-RPC
      // method / 协议版本 / 状态码；绝不记录 Authorization、Runtime Key、工具参数）。
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        this.recordRequest({ at: Date.now(), method: 'POST', path: url.split('?')[0] ?? '', hasSessionId: Boolean(sessionId), statusCode: 400 })
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }))
        return
      }
      const rpcBody = (body && typeof body === 'object' ? body : {}) as { method?: unknown; params?: { protocolVersion?: unknown } }
      const jsonRpcMethod = typeof rpcBody.method === 'string' ? rpcBody.method : undefined
      const headerVersion = req.headers['mcp-protocol-version']
      const protocolVersion = typeof rpcBody.params?.protocolVersion === 'string'
        ? rpcBody.params.protocolVersion
        : typeof headerVersion === 'string' ? headerVersion : undefined
      let statusCode = 200
      const originalWriteHead = res.writeHead.bind(res)
      res.writeHead = ((...args: Parameters<typeof originalWriteHead>) => {
        const status = args[0]
        if (typeof status === 'number') statusCode = status
        return originalWriteHead(...args)
      }) as typeof res.writeHead

      try {
        if (!sessionId) {
          // V5 §11：无 Session ID 不再默认当作 initialize——按 JSON-RPC method 分流。
          // initialize 走会话模型（legacy 兼容）；tools/list / tools/call 等现代无状态请求
          // 直接处理（TC-V5-MCP-01/02）。
          if (jsonRpcMethod === 'initialize' || jsonRpcMethod === undefined) {
            await this.handleInitialize(req, res, body, scope.profileId)
          } else {
            await this.handleStatelessRequest(req, res, body, scope.profileId)
          }
        } else {
          const entry = this.sessions.get(sessionId)
          if (!entry) {
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }))
          } else {
            this.sessions.touch(sessionId)
            await entry.transport.handleRequest(req, res, body)
          }
        }
      } finally {
        this.recordRequest({
          at: Date.now(),
          method: 'POST',
          path: url.split('?')[0] ?? '',
          hasSessionId: Boolean(sessionId),
          ...(jsonRpcMethod ? { jsonRpcMethod } : {}),
          ...(protocolVersion ? { protocolVersion } : {}),
          statusCode,
        })
      }
      return
    }

    // GET（SSE 流）保持会话模型
    const entry = sessionId ? this.sessions.get(sessionId) : undefined
    if (!entry) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }))
      return
    }
    this.sessions.touch(sessionId!)
    await entry.transport.handleRequest(req, res, undefined)
  }

  /** 构造已接线的 MCP Server 实例（会话模式与无状态模式共用，工具逻辑只有一份） */
  private createConfiguredServer(profileId: string | undefined): Server | undefined {
    if (!this.registry || !this.config || !this.resolveWorkspaceContext) {
      return undefined
    }
    const registry = this.registry
    const resolveWorkspaceContext = this.resolveWorkspaceContext
    const server = new Server(
      { name: 'Proma MCP', version: '2.0.0' },
      { capabilities: { tools: {} } },
    )

    server.setRequestHandler(ListToolsRequestSchema, () => {
      const config = this.config
      const registryNow = this.registry
      if (!config || !registryNow) return { tools: [] }
      return {
        tools: buildMcpToolViews(config, registryNow).map((view) => ({
          name: view.name,
          description: view.description,
          inputSchema: view.inputSchema,
          annotations: view.annotations,
        })),
      }
    })

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      const result = await this.dispatchToolCall(name, args, profileId, resolveWorkspaceContext, registry)
      const text = result.text ?? JSON.stringify(result.ok ? (result.data ?? {}) : (result.error ?? { ok: false }))
      return {
        content: [{ type: 'text', text }],
        ...(result.ok && result.data ? { structuredContent: result.data } : {}),
        isError: !result.ok,
      }
    })
    return server
  }

  /** 首次 POST（initialize）：为该客户端创建独立 transport + MCP Server 实例，绑定 endpoint 作用域 */
  private async handleInitialize(req: IncomingMessage, res: ServerResponse, body: unknown, profileId?: string): Promise<void> {
    const server = this.createConfiguredServer(profileId)
    if (!server) {
      res.writeHead(503).end()
      return
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        this.sessions.set(sessionId, { transport, server, createdAt: Date.now(), lastUsedAt: Date.now(), profileId })
      },
      onsessionclosed: (sessionId: string) => {
        this.sessions.delete(sessionId)
      },
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  /**
   * 现代无状态请求（V5 §11）：tools/list / tools/call 等不带 Mcp-Session-Id 的
   * JSON-RPC 请求，按每次请求独立的 stateless transport 处理（SDK 官方 stateless
   * 模式：sessionIdGenerator 为 undefined），请求结束即释放，不维护会话。
   */
  private async handleStatelessRequest(req: IncomingMessage, res: ServerResponse, body: unknown, profileId?: string): Promise<void> {
    const server = this.createConfiguredServer(profileId)
    if (!server) {
      res.writeHead(503).end()
      return
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless 模式
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } finally {
      try { await transport.close() } catch { /* 一次性请求 */ }
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : undefined
}
