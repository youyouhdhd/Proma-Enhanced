/**
 * protocol/modern-handler — 现代 MCP Discovery 兼容（V7）
 *
 * ChatGPT Connector 在 tools/list 之前可能发送 `server/discover`。
 * 当前 MCP TypeScript SDK v1.x 不认识该方法（会返回 -32601），导致
 * ChatGPT 在 tools/list 之前终止 discovery。
 *
 * V7 方案（§13/§14）：在 v1 SDK 之前拦截 `server/discover` 并以兼容 shim 响应。
 * TODO(SPIKE-MCP-SDK-MODERN)：升级现代 MCP SDK 后，用官方 schema/handler 替换本 shim
 * 并补充完整协议测试（V7 §32/§33）。删除路径：移除本文件 + route 拦截分支。
 */

import type { IncomingHttpHeaders, ServerResponse } from 'node:http'

/** PROMA MCP 对外声明的协议版本与身份 */
export const MODERN_PROTOCOL_VERSION = '2026-07-28'
export const PROMA_MCP_SERVER_NAME = 'Proma MCP'
export const PROMA_MCP_SERVER_VERSION = '1.6.0'

/** server/discover 的兼容响应（概念结构以 V7 §12 为准；升级 SDK 后走官方 schema） */
export interface ServerDiscoverResult {
  protocolVersions: string[]
  capabilities: { tools: Record<string, never> }
  serverInfo: { name: string; version: string }
}

export function buildServerDiscoverResult(): ServerDiscoverResult {
  return {
    protocolVersions: [MODERN_PROTOCOL_VERSION],
    capabilities: { tools: {} },
    serverInfo: { name: PROMA_MCP_SERVER_NAME, version: PROMA_MCP_SERVER_VERSION },
  }
}

/** 该 JSON-RPC method 是否为本模块拦截的现代 discovery 方法 */
export function isModernDiscoveryMethod(jsonRpcMethod: string | undefined): boolean {
  return jsonRpcMethod === 'server/discover'
}

/** 直接响应 server/discover（JSON-RPC result + 协议版本头），并返回实际状态码 */
export function respondServerDiscover(_req: { headers: IncomingHttpHeaders }, res: ServerResponse, requestId: unknown): number {
  res.writeHead(200, {
    'content-type': 'application/json',
    'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
  })
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    id: requestId ?? null,
    result: buildServerDiscoverResult(),
  }))
  return 200
}
