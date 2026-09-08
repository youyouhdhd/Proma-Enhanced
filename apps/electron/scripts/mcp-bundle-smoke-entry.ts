/** esbuild CJS + Electron 内嵌 Node 的协议运行冒烟；不访问真实用户配置。 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { withMcpServer } from '../src/main/lib/mcp-server/protocol/test-fixture'

void withMcpServer(async (server, endpoint) => {
  const client = new Client({ name: 'electron-bundle-smoke', version: '1' }, { versionNegotiation: { mode: 'auto' } })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
    if (client.getProtocolEra() !== 'modern') throw new Error('协议发生回退')
    const tools = await client.listTools()
    if (!tools.tools.some((t) => t.name === 'read_file')) throw new Error('未发现工具')
    for (const name of ['workspace_list', 'git_status', 'read_file']) {
      const result = await client.callTool({ name, arguments: name === 'read_file' ? { path: 'hello.txt' } : {} })
      if (result.isError) throw new Error('工具执行失败')
    }
    if (server.getStatus().recentRequests.some((t) => t.statusCode === 406 || t.jsonRpcMethod === 'initialize')) throw new Error('出现回退或 406')
    console.log('MCP CJS/Electron runtime smoke PASS；Node ' + process.versions.node + '；Electron ' + (process.versions.electron ?? 'n/a'))
  } finally { await client.close() }
}).catch(() => { console.error('MCP CJS/Electron runtime smoke FAIL'); process.exitCode = 1 })
