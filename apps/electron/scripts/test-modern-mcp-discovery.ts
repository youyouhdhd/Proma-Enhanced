/**
 * PROMA MCP Modern Discovery 测试脚本（V7 §23/§52）
 *
 * 对一个运行中的 PROMA Local MCP endpoint 模拟 ChatGPT Connector 的现代
 * discovery 流程：server/discover → tools/list → tools/call workspace_list。
 *
 * 用法：
 *   bun run scripts/test-modern-mcp-discovery.ts [endpoint] （认证仅通过 PROMA_MCP_AUTH_HEADER 环境变量提供）
 *   （endpoint 默认 http://127.0.0.1:8787/mcp；也可用 PROMA_MCP_URL 环境变量）
 *
 * 退出码：全部通过 0；任一步失败 1。
 */

import { isSpecType } from '@modelcontextprotocol/server'
import { MODERN_PROTOCOL_VERSION } from '../src/main/lib/mcp-server/protocol/modern-server'

interface RpcResponse {
  result?: unknown
  error?: { code: number; message: string }
}

const endpoint = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : (process.env.PROMA_MCP_URL ?? 'http://127.0.0.1:8787/mcp')
const bearer = process.env.PROMA_MCP_AUTH_HEADER?.replace(/^Bearer\s+/i, '')

async function rpc(method: string, params?: Record<string, unknown>): Promise<{ ok: boolean; http: number; payload: RpcResponse }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
      'mcp-method': method,
      ...(typeof params?.name === 'string' ? { 'mcp-name': params.name } : {}),
      ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION, 'io.modelcontextprotocol/clientInfo': { name: 'proma-wire', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
  })
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  let payload: RpcResponse = {}
  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split(/\r?\n/).reverse().find((line) => line.startsWith('data:'))
    payload = dataLine ? JSON.parse(dataLine.slice(5).trim()) : {}
  } else {
    payload = text ? JSON.parse(text) : {}
  }
  return { ok: response.status === 200 && !payload.error && Boolean(payload.result), http: response.status, payload }
}

async function main(): Promise<void> {
  console.log('PROMA MCP Modern Discovery Test')
  console.log('endpoint:', new URL(endpoint).origin + new URL(endpoint).pathname)
  let failed = false

  const discover = await rpc('server/discover')
  const discoveryValid = isSpecType.DiscoverResult(discover.payload.result)
  console.log('server/discover ', discover.ok && discoveryValid ? '✓ 官方 schema' : '✗ HTTP ' + discover.http)
  if (!discover.ok || !discoveryValid) failed = true

  const toolsList = await rpc('tools/list')
  const tools = (toolsList.payload.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []
  console.log('tools/list      ', toolsList.ok ? '✓ (' + tools.length + ' tools)' : '✗ HTTP ' + toolsList.http + (toolsList.payload.error ? ' RPC ' + toolsList.payload.error.code : ''))
  if (!toolsList.ok || !isSpecType.ListToolsResult(toolsList.payload.result) || !tools.length) failed = true

  const call = await rpc('tools/call', { name: 'workspace_list', arguments: {} })
  console.log('workspace_list  ', call.ok ? '✓' : '✗ HTTP ' + call.http + (call.payload.error ? ' RPC ' + call.payload.error.code : ''))
  if (!call.ok || (call.payload.result as { isError?: boolean } | undefined)?.isError === true) failed = true

  if (failed) process.exit(1)
  console.log('')
  console.log('All modern discovery steps passed.')
}

void main().catch((error) => {
  console.error('测试执行失败:', error instanceof Error ? error.name : 'unknown')
  process.exit(1)
})
