/**
 * protocol/request-trace — MCP 请求观测（V7 §5-§7/§19）
 * 只记录非敏感数据：method / path / session 有无 / JSON-RPC method / 协议版本 /
 * 状态码 / 认证结果 / 安全头（content-type、accept、mcp-protocol-version、
 * mcp-method、mcp-name、user-agent）/ JSON-RPC error code。
 * 绝不记录：Authorization、Cookie、Runtime API Key、Local Bearer、工具参数、文件内容。
 */

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

/** 捕获响应状态码（transport 在内部调用 writeHead） */
export function captureStatusCode(res: ServerResponse): void {
  const originalWriteHead = res.writeHead.bind(res)
  const state = res as ServerResponse & { __promaStatus?: number }
  res.writeHead = ((...args: unknown[]) => {
    const status = args[0]
    if (typeof status === 'number') state.__promaStatus = status
    return (originalWriteHead as (...a: unknown[]) => unknown)(...args)
  }) as typeof res.writeHead
}

export function getCapturedStatusCode(res: ServerResponse): number {
  const state = res as ServerResponse & { __promaStatus?: number }
  return state.__promaStatus ?? 200
}

export interface CapturedRpcError {
  code: number
  message: string
}

/**
 * 捕获 JSON 响应体以提取 JSON-RPC error code（V7 §20/§21）。
 * HTTP 200 也可能携带 RPC error（如 -32601），不能只看 HTTP status。
 * 只保留 error code + 截断 message，不保存完整响应。
 */
export function captureJsonRpcError(res: ServerResponse, onError: (err: CapturedRpcError) => void): void {
  const chunks: Buffer[] = []
  let totalSize = 0
  const state = res as ServerResponse & { __promaBodyHooked?: boolean }
  if (state.__promaBodyHooked) return
  state.__promaBodyHooked = true
  const originalWrite = res.write.bind(res) as typeof res.write
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      totalSize += buffer.length
      if (totalSize <= 64 * 1024) chunks.push(buffer)
    }
    return (originalWrite as (...writeArgs: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof res.write
  const originalEnd = res.end.bind(res) as typeof res.end
  res.end = ((...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg === 'string' || Buffer.isBuffer(arg)) {
        const buffer = typeof arg === 'string' ? Buffer.from(arg) : arg
        totalSize += buffer.length
        if (totalSize <= 64 * 1024) chunks.push(buffer)
      }
    }
    try {
      const raw = Buffer.concat(chunks).toString('utf8')
      const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } }
      if (parsed?.error && typeof parsed.error.code === 'number') {
        onError({
          code: parsed.error.code,
          message: typeof parsed.error.message === 'string' ? parsed.error.message.slice(0, 200) : '',
        })
      }
    } catch { /* 非 JSON 响应（SSE 流等）不解析 */ }
    return (originalEnd as (...endArgs: unknown[]) => ServerResponse)(...args)
  }) as typeof res.end
}

/** 已知 MCP 方法分类（V7 §6） */
const KNOWN_METHODS = ['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping'] as const

/** 计算方法直方图（V7 §6） */
export function computeMethodStats(traces: PromaMcpRequestTrace[]): PromaMcpMethodStats {
  const stats: PromaMcpMethodStats = {
    total: traces.length,
    methods: {},
    statuses: {},
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
    else if (trace.jsonRpcMethod === 'initialize' || trace.jsonRpcMethod === 'notifications/initialized') stats.initializeCount += 1
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
