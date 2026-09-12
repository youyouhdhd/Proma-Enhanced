/** 官方现代协议入口：SDK 负责 Discovery/metadata；PROMA 明确限定可返回的媒体类型。 */
import { createMcpHandler, Server, isSpecType, type Tool, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { version } from '../../../../../package.json'
import type { McpToolView } from '../tool-adapter'
import { PROMA_MCP_INSTRUCTIONS } from './server-instructions'

export const MCP_SERVER_INFO = { name: 'Proma MCP', version }
// SDK 的 LATEST_PROTOCOL_VERSION 为兼容旧握手仍指向 2025；显式选择已验证的现代版本。
export const MODERN_PROTOCOL_VERSION = '2026-07-28'

export interface McpToolHandlers {
  list(): McpToolView[]
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>
}

export interface ModernServerOptions {
  instructions?: string
}

export function validatedTools(handlers: McpToolHandlers): Tool[] {
  return handlers.list().map((view) => {
    if (!isSpecType.Tool(view)) throw new Error('MCP 工具 schema 不符合官方规范: ' + view.name)
    return view
  })
}

export function createModernServer(handlers: McpToolHandlers, options: ModernServerOptions = {}) {
  const handler = createMcpHandler(() => {
    const server = new Server(MCP_SERVER_INFO, {
      capabilities: { tools: {} },
      instructions: options.instructions ?? PROMA_MCP_INSTRUCTIONS,
    })
    server.setRequestHandler('tools/list', () => ({ tools: validatedTools(handlers) }))
    server.setRequestHandler('tools/call', (request) => handlers.call(request.params.name, request.params.arguments ?? {}))
    return server
  })
  // PROMA 工具只返回终态 JSON；兼容 JSON-only 客户端，明确拒绝无法接收 JSON 的 Accept。
  // 官方规范要求客户端声明 JSON + SSE；这里的宽容策略不修改请求头或协议 metadata。
  const nodeHandler = toNodeHandler({
    fetch: async (request, options) => {
      if (request.method === 'POST' && !acceptsJson(request.headers.get('accept'))) {
        return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Accept does not support application/json' } }, { status: 406 })
      }
      return handler.fetch(request, options)
    },
  })
  return { handle: nodeHandler, close: handler.close }
}

function acceptsJson(accept: string | null): boolean {
  if (!accept) return true
  const ranges = accept.toLowerCase().split(',').map((part) => {
    const [media, ...params] = part.trim().split(';')
    const q = params.find((p) => p.trim().startsWith('q='))?.trim().slice(2)
    return { media: media?.trim(), quality: q === undefined ? 1 : Number(q) }
  })
  // 显式 application/json;q=0 优先于通配符，不能被 */* 再放行。
  for (const media of ['application/json', 'application/*', '*/*']) {
    const match = ranges.find((r) => r.media === media)
    if (match) return Number.isFinite(match.quality) && match.quality > 0 && match.quality <= 1
  }
  return false
}
