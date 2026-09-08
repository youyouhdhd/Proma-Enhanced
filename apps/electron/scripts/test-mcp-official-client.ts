/** 对已运行 endpoint 做官方 Client 验证；凭据仅从环境变量读取。 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
const endpoint = process.argv[2] ?? process.env.PROMA_MCP_URL ?? 'http://127.0.0.1:8787/mcp'
const client = new Client({ name: 'Proma official-client verification', version: '1' }, { versionNegotiation: { mode: 'auto' } })
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: process.env.PROMA_MCP_AUTH_HEADER ? { authorization: process.env.PROMA_MCP_AUTH_HEADER } : {} },
  }))
  if (client.getProtocolEra() !== 'modern') throw new Error('LEGACY_FALLBACK')
  const list = await client.listTools()
  if (!list.tools.some((t) => t.name === 'workspace_list')) throw new Error('TOOLS_NOT_FOUND')
  const call = await client.callTool({ name: 'workspace_list', arguments: {} })
  if (call.isError) throw new Error('TOOL_CALL_FAILED')
  console.log('官方 Client：modern；tools/list ' + list.tools.length + ' 个；workspace_list 成功')
} catch {
  console.error('官方 Client 验证失败；请查看 PROMA Protocol Debug（此脚本不输出远端错误原文或工具内容）')
  process.exitCode = 1
} finally { await client.close() }
