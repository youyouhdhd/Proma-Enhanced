/** esbuild CJS + Electron 内嵌 Node 的协议运行冒烟；不访问真实用户配置。 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { withMcpServer } from '../src/main/lib/mcp-server/protocol/test-fixture'
import { PublicMcpIngress } from '../src/main/lib/mcp-transport/public-ingress'
import { probePublicMcp } from '../src/main/lib/mcp-transport/public-probe'
import { createConfiguredTools } from '../src/main/lib/mcp-server/configured-tools'
import { createDefaultLocalToolRegistry } from '../src/main/lib/local-tools/registry'
import { normalizePromaMcpServerConfig } from '../src/main/lib/mcp-server/config'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

async function verifyPublicIngress(): Promise<void> {
  const rootPath = mkdtempSync(join(tmpdir(), 'proma-public-cjs-'))
  const entry = { id: 'ws_cjs', name: 'CJS smoke', rootPath, enabled: true, permissions: { read: true, write: false, shell: false } }
  const secret = randomBytes(32).toString('base64url')
  const tools = createConfiguredTools({ config: () => normalizePromaMcpServerConfig({ accessMode: 'read-only' }), entries: () => [entry],
    registry: createDefaultLocalToolRegistry(), resolve: () => ({ entry, context: { rootPath, workspaceId: entry.id } }) })
  const ingress = new PublicMcpIngress(tools, () => secret, 'cjs-probe')
  try {
    const local = await ingress.start(0)
    const result = await probePublicMcp(local + '/mcp/' + secret, 'cjs-probe')
    if (!result.modern || result.toolCount !== 10 || JSON.stringify(ingress.getRequests()).includes(secret)) throw new Error('Public MCP 验证失败')
  } finally { await ingress.stop(); rmSync(rootPath, { recursive: true, force: true }) }
}

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
    await verifyPublicIngress()
    console.log('MCP CJS/Electron runtime smoke PASS（Local + Public）；Node ' + process.versions.node + '；Electron ' + (process.versions.electron ?? 'n/a'))
  } finally { await client.close() }
}).catch(() => { console.error('MCP CJS/Electron runtime smoke FAIL'); process.exitCode = 1 })
