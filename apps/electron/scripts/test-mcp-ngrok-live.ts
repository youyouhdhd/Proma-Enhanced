/** 显式执行的真实 ngrok Gate；只暴露新建测试目录，不调用模型或修改账号配置。 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, createHash } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { NgrokProvider } from '../src/main/lib/mcp-transport/ngrok-provider'
import { PublicMcpIngress } from '../src/main/lib/mcp-transport/public-ingress'
import { normalizeSharing } from '../src/main/lib/mcp-sharing/config'
import { createPrimitiveCatalog, toolFingerprint } from '../src/main/lib/mcp-sharing/catalog'

const base = mkdtempSync(join(tmpdir(), 'proma-v12-live-'))
const entries = ['one', 'two', 'three'].map((id) => {
  const rootPath = join(base, id); mkdirSync(rootPath); writeFileSync(join(rootPath, 'README.txt'), `isolated fixture ${id}`)
  return { id, name: id, rootPath, enabled: true, permissions: { read: true, write: true, shell: true } }
})
const config = normalizeSharing({ version: 2, enabled: true, roots: [], tools: { fileRead: true, fileWrite: true, shell: true }, policy: { read: 'direct', write: 'direct', execute: 'direct' } })
const tools = createPrimitiveCatalog(() => config, () => entries, (id) => {
  const entry = entries.find((candidate) => candidate.id === id)
  return entry ? { entry, context: { workspaceId: id, rootPath: entry.rootPath } } : { error: 'not allowed' }
})
const secret = randomBytes(32).toString('base64url')
const ingress = new PublicMcpIngress(tools, () => secret, 'v12-live')
let provider: NgrokProvider | undefined
let client: Client | undefined
try {
  await ingress.start(0)
  provider = new NgrokProvider({ authSource: 'system-config', endpointMode: 'auto-domain' }, ingress, () => secret, () => undefined, 'v12-live', () => undefined)
  const automatic = await provider.start()
  if (automatic.phase !== 'ready' || !automatic.endpoint?.publicUrl) throw new Error(JSON.stringify({ code: automatic.errorCode, logs: automatic.logs?.slice(-12) }))
  const origin = automatic.endpoint.publicUrl
  await provider.stop()
  provider = new NgrokProvider({ authSource: 'system-config', endpointMode: 'fixed-domain', hostname: origin }, ingress, () => secret, () => undefined, 'v12-live', () => undefined)
  const ready = await provider.start()
  if (ready.phase !== 'ready' || ready.endpoint?.publicUrl !== origin) throw new Error(JSON.stringify({ code: ready.errorCode, logs: ready.logs?.slice(-12) }))
  client = new Client({ name: 'proma-v12-live', version: '1' }, { versionNegotiation: { mode: 'auto' } })
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp/' + secret)))
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client!.callTool({ name, arguments: args })
    if (result.isError) throw new Error('LIVE_TOOL_FAILED: ' + name)
    return result
  }
  await call('workspace_list', {})
  await call('read_file', { workspace_id: 'one', path: 'README.txt' })
  await call('write_file', { workspace_id: 'two', path: 'created.txt', content: 'isolated write fixture' })
  await call('shell_execute', { workspace_id: 'three', command: 'echo proma-v12-isolated' })
  const fingerprint = toolFingerprint(tools)
  const fourth = join(base, 'four'); mkdirSync(fourth); writeFileSync(join(fourth, 'README.txt'), 'hot fixture')
  entries.push({ ...entries[0]!, id: 'four', name: 'four', rootPath: fourth })
  await call('read_file', { workspace_id: 'four', path: 'README.txt' })
  if (toolFingerprint(tools) !== fingerprint || provider.getStatus().pid !== ready.pid || provider.getStatus().endpoint?.publicUrl !== origin) throw new Error('LIVE_HOT_IDENTITY_CHANGED')
  entries.pop()
  if (!(await client.callTool({ name: 'read_file', arguments: { workspace_id: 'four', path: 'README.txt' } })).isError) throw new Error('LIVE_REVOKE_FAILED')
  console.log(JSON.stringify({ result: 'PASS', systemConfig: true, fixedRestart: true, projectCount: 3, hotAddRemove: true, directReadWriteShell: true, connectorFingerprint: createHash('sha256').update(origin + '/mcp/' + secret).digest('hex'), modelCalls: 0 }))
} catch (error) { console.error(error instanceof Error ? error.message : 'NGROK_LIVE_FAILED'); process.exitCode = 1 }
finally {
  await client?.close().catch(() => undefined); await provider?.stop(); await ingress.stop()
  const inside = relative(resolve(tmpdir()), resolve(base))
  if (!isAbsolute(inside) && !inside.startsWith('..') && inside.startsWith('proma-v12-live-')) rmSync(base, { recursive: true, force: true })
}
