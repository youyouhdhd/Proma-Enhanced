/**
 * PROMA MCP Modern Discovery 测试脚本（V7 §23/§52）
 *
 * 对一个运行中的 PROMA Local MCP endpoint 模拟 ChatGPT Connector 的现代
 * discovery 流程：server/discover → tools/list → tools/call workspace_list。
 *
 * 用法：
 *   bun run scripts/test-modern-mcp-discovery.ts [endpoint] [--bearer <token>]
 *   （endpoint 默认 http://127.0.0.1:8787/mcp；也可用 PROMA_MCP_URL 环境变量）
 *
 * 退出码：全部通过 0；任一步失败 1。
 */

interface RpcResponse {
  result?: unknown
  error?: { code: number; message: string }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const endpoint = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : (process.env.PROMA_MCP_URL ?? 'http://127.0.0.1:8787/mcp')
const bearer = arg('--bearer') ?? process.env.PROMA_MCP_AUTH_HEADER?.replace(/^Bearer\s+/i, '')

async function rpc(method: string, params?: Record<string, unknown>): Promise<{ ok: boolean; http: number; payload: RpcResponse }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, ...(params ? { params } : {}) }),
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
  return { ok: response.status === 200 && !payload.error, http: response.status, payload }
}

async function main(): Promise<void> {
  console.log('PROMA MCP Modern Discovery Test')
  console.log('endpoint:', endpoint)
  let failed = false

  const discover = await rpc('server/discover')
  const discoverResult = discover.payload.result as { protocolVersions?: string[]; serverInfo?: { version?: string } } | undefined
  const discoverLabel = discover.ok ? '✓' + (discoverResult?.serverInfo?.version ? ' (' + discoverResult.serverInfo.version + ')' : '') : '✗ HTTP ' + discover.http + (discover.payload.error ? ' RPC ' + discover.payload.error.code : '')
  console.log('server/discover ', discoverLabel)
  if (discoverResult?.protocolVersions) console.log('Protocol        ', discoverResult.protocolVersions.join(', '))
  if (!discover.ok) failed = true

  const toolsList = await rpc('tools/list')
  const tools = (toolsList.payload.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []
  console.log('tools/list      ', toolsList.ok ? '✓ (' + tools.length + ' tools)' : '✗ HTTP ' + toolsList.http + (toolsList.payload.error ? ' RPC ' + toolsList.payload.error.code : ''))
  if (!toolsList.ok) failed = true

  const call = await rpc('tools/call', { name: 'workspace_list', arguments: {} })
  console.log('workspace_list  ', call.ok ? '✓' : '✗ HTTP ' + call.http + (call.payload.error ? ' RPC ' + call.payload.error.code : ''))
  if (!call.ok) failed = true

  if (failed) process.exit(1)
  console.log('')
  console.log('All modern discovery steps passed.')
}

void main().catch((error) => {
  console.error('测试执行失败:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
