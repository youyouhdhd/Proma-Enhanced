import { it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSharing } from './config'
import { createPrimitiveCatalog, toolFingerprint } from './catalog'
import { RemoteExecutionGuard } from './tool-policy'
import { PublicMcpIngress } from '../mcp-transport/public-ingress'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

it('Given 一个Connector多项目 When Direct写入和Shell及热撤权 Then 逐项目隔离且缓存调用被拒绝', async () => {
  const base = mkdtempSync(join(tmpdir(), 'proma-v12-full-'))
  const entries = ['one', 'two'].map((id) => { const rootPath = join(base, id); mkdirSync(rootPath); return { id, name: id, rootPath, enabled: true, permissions: { read: true, write: id === 'one', shell: id === 'one' } } })
  let config = normalizeSharing({ version: 2, enabled: true, roots: [], tools: { fileRead: true, fileWrite: true, shell: true }, policy: { read: 'direct', write: 'disabled', execute: 'disabled' } })
  const tools = createPrimitiveCatalog(() => config, () => entries, (id) => {
    const entry = entries.find((root) => root.id === id)
    return entry ? { entry, context: { workspaceId: id, rootPath: entry.rootPath } } : { error: 'denied' }
  })
  const ingress = new PublicMcpIngress(tools, () => 's'.repeat(43), 'test')
  const local = await ingress.start(0)
  const client = new Client({ name: 'v12-full', version: '1' }, { versionNegotiation: { mode: 'auto' } })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(local + '/mcp/' + 's'.repeat(43))))
    expect((await client.listTools()).tools.some((tool) => tool.name === 'write_file')).toBe(false)
    config = { ...config, policy: { read: 'direct', write: 'direct', execute: 'direct' } }
    expect((await client.listTools()).tools.some((tool) => tool.name === 'shell_execute')).toBe(true)
    const fp = toolFingerprint(tools)
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
    expect((await call('write_file', { workspace_id: 'one', path: 'sample.txt', content: 'fixture' })).isError).toBe(false)
    expect(readFileSync(join(entries[0]!.rootPath, 'sample.txt'), 'utf8')).toBe('fixture')
    expect((await call('write_file', { workspace_id: 'two', path: 'sample.txt', content: 'denied' })).isError).toBe(true)
    expect((await call('write_file', { workspace_id: 'one', path: '../escape.txt', content: 'denied' })).isError).toBe(true)
    expect((await call('shell_execute', { workspace_id: 'one', command: 'echo v12-fixture' })).isError).toBe(false)
    expect((await call('shell_execute', { workspace_id: 'two', command: 'echo denied' })).isError).toBe(true)
    entries[0]!.permissions.shell = false
    expect(toolFingerprint(tools)).toBe(fp)
    expect((await call('shell_execute', { workspace_id: 'one', command: 'echo denied' })).isError).toBe(true)
    config = { ...config, policy: { ...config.policy, execute: 'disabled' } }
    expect((await call('shell_execute', { workspace_id: 'one', command: 'echo denied' })).isError).toBe(true)
  } finally { await client.close(); await ingress.stop(); rmSync(base, { recursive: true, force: true }) }
})

it('Given 远程执行额度 When 并发/撤销/迁移 Then 单Shell并发且旧配置不会开启写入', () => {
  const config = normalizeSharing({ version: 2, roots: [], enabled: true, policy: { write: 'direct', execute: 'direct' } })
  const guard = new RemoteExecutionGuard()
  const lease = guard.acquire('execute', 'one', config)
  expect(() => guard.acquire('execute', 'one', config)).toThrow('REMOTE_RATE_LIMIT')
  guard.revoke(); expect(lease.signal.aborted).toBe(true); lease.release()
  expect(normalizeSharing({ version: 1, roots: [], policy: { write: 'direct', execute: 'direct' } }).policy.write).toBe('disabled')
})

it('Given Direct 与 Agent 动作共用执行守卫 When 只关闭其中一方策略 Then 只撤销对应来源的租约', () => {
  const root = { id: 'one', name: 'one', rootPath: process.cwd(), enabled: true, agentWorkspaceId: 'agent-one', permissions: { read: true, write: true, shell: true } }
  const guard = new RemoteExecutionGuard()
  const config = normalizeSharing({ version: 3, enabled: true, roots: [], tools: { fileRead: true, fileWrite: true, shell: true, search: true, git: true }, policy: { read: 'direct', write: 'disabled', execute: 'disabled' }, delegation: { enabled: true, action: { mode: 'direct', write: true, execute: false } } })
  const direct = guard.acquire('write', root.id, config, 'direct')
  const agent = guard.acquire('write', root.id, config, 'agent')
  const directDisabled = { ...config, policy: { ...config.policy, write: 'disabled' as const } }
  guard.reconcile([root], directDisabled)
  expect(direct.signal.aborted).toBe(true)
  expect(agent.signal.aborted).toBe(false)
  const agentDisabled = { ...directDisabled, delegation: { ...directDisabled.delegation, action: { mode: 'analysis' as const, write: false, execute: false } } }
  guard.reconcile([root], agentDisabled)
  expect(agent.signal.aborted).toBe(true)
  direct.release(); agent.release()
})
