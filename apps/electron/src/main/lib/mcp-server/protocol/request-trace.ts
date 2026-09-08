/**
 * protocol/request-trace — MCP 请求观测（V7 §5-§7/§19）
 * 只记录非敏感数据：method / path / session 有无 / JSON-RPC method / 协议版本 /
 * 状态码 / 认证结果 / 安全头（content-type、accept、mcp-protocol-version、
 * mcp-method、mcp-name、user-agent）/ JSON-RPC error code。
 * 绝不记录：Authorization、Cookie、Runtime API Key、Local Bearer、工具参数、文件内容。
 */

import { isSpecType } from '@modelcontextprotocol/server'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { PromaMcpMethodStats, PromaMcpRequestTrace } from '@proma/shared'

/** 允许记录的非敏感请求头白名单（V7 §18/§43） */
const SAFE_HEADER_KEYS = ['content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'user-agent'] as const

export type SafeRequestMetadata = NonNullable<PromaMcpRequestTrace['requestMetadata']>

/** 从请求头提取白名单内的非敏感 metadata（undefined 字段不落盘） */
export function extractSafeRequestMetadata(headers: IncomingHttpHeaders): SafeRequestMetadata | undefined {
  const get = (key: (typeof SAFE_HEADER_KEYS)[number]): string | undefined => {
    const value = headers[key]
    const text = Array.isArray(value) ? value[0] : value
    return typeof text === 'string' && text.length > 0 ? text.slice(0, 300) : undefined
  }
  const metadata: SafeRequestMetadata = {
    ...(get('content-type') ? { contentType: get('content-type') } : {}),
    ...(get('accept') ? { accept: get('accept') } : {}),
    ...(get('mcp-protocol-version') ? { protocolVersionHeader: get('mcp-protocol-version') } : {}),
    ...(get('mcp-method') ? { mcpMethod: get('mcp-method') } : {}),
    ...(get('mcp-name') ? { mcpName: get('mcp-name') } : {}),
    ...(get('user-agent') ? { userAgent: get('user-agent') } : {}),
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

/** 仅保留结构化结果证据；错误原文、工具内容不进入 trace。 */
export function captureRpcResponse(res: ServerResponse): () => Partial<PromaMcpRequestTrace> {
  let buffer = ''
  let overflow = false
  const summary: Partial<PromaMcpRequestTrace> = {}
  const parse = (raw: string): void => {
    try {
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object') return
      const rpc = value as { result?: unknown; error?: { code?: unknown; message?: unknown } }
      if (typeof rpc.error?.code === 'number') {
        summary.rpcErrorCode = rpc.error.code
        // 原文仅用于映射安全枚举，绝不持久化或返回给 UI。
        const message = typeof rpc.error.message === 'string' ? rpc.error.message.toLowerCase() : ''
        summary.responseReason = message.includes('accept') ? 'accept-not-supported'
          : message.includes('content-type') ? 'content-type-not-supported'
          : message.includes('version') ? 'protocol-version-rejected' : 'transport-rejected'
      } else if (rpc.result !== undefined) {
        summary.rpcResultOk = true
        if (isSpecType.ListToolsResult(rpc.result)) {
          summary.toolCount = rpc.result.tools.length
          summary.schemaValidated = true
        }
        if (isSpecType.DiscoverResult(rpc.result)) summary.discoverValidated = true
        if (rpc.result && typeof rpc.result === 'object' && 'isError' in rpc.result) {
          summary.toolCallOk = rpc.result.isError !== true
        }
      }
    } catch { /* 不完整帧或非 JSON */ }
  }
  const consume = (chunk: unknown): void => {
    if (overflow || !(typeof chunk === 'string' || chunk instanceof Uint8Array)) return
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    if (Buffer.byteLength(buffer) > 256 * 1024) { buffer = ''; overflow = true; return }
    if (String(res.getHeader('content-type')).includes('text/event-stream')) {
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (data) parse(data)
      }
    }
  }
  const originalWrite = res.write.bind(res)
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    consume(chunk)
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof res.write
  const originalEnd = res.end.bind(res)
  res.end = ((...args: unknown[]) => {
    consume(args[0])
    if (!overflow && buffer) parse(buffer)
    buffer = ''
    return (originalEnd as (...args: unknown[]) => ServerResponse)(...args)
  }) as typeof res.end
  return () => ({
    ...summary,
    ...(!summary.responseReason && res.statusCode >= 400 ? {
      responseReason: res.statusCode === 406 ? 'accept-not-supported' : res.statusCode === 415 ? 'content-type-not-supported' : 'unknown',
    } as const : {}),
  })
}

/** 已知 MCP 方法分类（V7 §6） */
const KNOWN_METHODS = ['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping'] as const

/** 计算方法直方图（V7 §6） */
export function computeMethodStats(traces: PromaMcpRequestTrace[]): PromaMcpMethodStats {
  const stats: PromaMcpMethodStats = {
    total: traces.length,
    methods: Object.create(null) as Record<string, number>,
    statuses: Object.create(null) as Record<string, number>,
    discoverCount: 0,
    initializeCount: 0,
    toolsListCount: 0,
    toolsCallCount: 0,
    unknownCount: 0,
  }
  for (const trace of traces) {
    const method = trace.jsonRpcMethod ?? '(' + trace.method + ' ' + trace.statusCode + ')'
    stats.methods[method] = (stats.methods[method] ?? 0) + 1
    const statusKey = String(trace.statusCode)
    stats.statuses[statusKey] = (stats.statuses[statusKey] ?? 0) + 1
    if (trace.jsonRpcMethod === 'server/discover') stats.discoverCount += 1
    else if (trace.jsonRpcMethod === 'initialize') stats.initializeCount += 1
    else if (trace.jsonRpcMethod === 'tools/list') stats.toolsListCount += 1
    else if (trace.jsonRpcMethod === 'tools/call') stats.toolsCallCount += 1
    else if (trace.jsonRpcMethod !== undefined && !KNOWN_METHODS.includes(trace.jsonRpcMethod as (typeof KNOWN_METHODS)[number])) stats.unknownCount += 1
  }
  return stats
}

/** IncomingMessage 快照辅助（供 trace 使用） */
export function requestPath(url: string | undefined): string {
  return url?.split('?')[0] ?? ''
}

export type { IncomingMessage }
