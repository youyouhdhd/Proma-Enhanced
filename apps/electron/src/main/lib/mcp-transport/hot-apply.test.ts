import { it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CloudflareProvider } from './cloudflare-provider'
import { NetworkProvider } from './network-provider'
import { PublicMcpIngress } from './public-ingress'
import { probePublicMcp } from './public-probe'
import { normalizeRemoteConfig, remoteApplyImpact } from './config'
import { normalizeSharing } from '../mcp-sharing/config'
import { createPrimitiveCatalog, toolFingerprint } from '../mcp-sharing/catalog'

it('Given 稳定 Provider Ready When Root/读取权限/Git 设置热更新 Then PID与URL不变且撤销实时生效', async () => {
  const base = mkdtempSync(join(tmpdir(), 'proma-hot-'))
  const one = join(base, 'one'); const two = join(base, 'two'); mkdirSync(one); mkdirSync(two)
  writeFileSync(join(one, 'README.md'), 'one'); writeFileSync(join(two, 'README.md'), 'two')
  let config = normalizeSharing({ enabled: true, roots: [], tools: { fileRead: true, git: true, search: true } })
  let entries = [{ id: 'one', name: 'one', rootPath: one, enabled: true, permissions: { read: true, write: false, shell: false } }]
  const catalog = createPrimitiveCatalog(() => config, () => entries, (id) => { const entry = entries.find((e) => e.id === id)!; return { entry, context: { workspaceId: id, rootPath: entry.rootPath } } })
  const secret = randomBytes(32).toString('base64url')
  const ingress = new PublicMcpIngress(catalog, () => secret, 'probe')
  const local = await ingress.start(0)
  const remote = normalizeRemoteConfig({ version: 2, enabled: true, provider: 'cloudflare-named', providers: { 'cloudflare-named': { hostname: 'https://stable.example.com' } } })
  let spawns = 0; let kills = 0; let failProbe = false
  const child = Object.assign(new EventEmitter(), { pid: 77, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: () => { kills++; return true } }) as unknown as ChildProcess
  const provider = new CloudflareProvider('cloudflare-named', remote, ingress, () => secret, () => 'fixture-token', 'probe', {
    version: async () => 'cloudflared test', spawn: () => { spawns++; return child },
    probe: async (_url, marker) => { if (failProbe) throw new Error('offline'); return probePublicMcp(local + '/mcp/' + secret, marker) },
  })
  const client = new Client({ name: 'hot-test', version: '1' }, { versionNegotiation: { mode: 'auto' } })
  try {
    const ready = await provider.start()
    await client.connect(new StreamableHTTPClientTransport(new URL(local + '/mcp/' + secret)))
    const fp = toolFingerprint(catalog)
    entries.push({ ...entries[0]!, id: 'two', name: 'two', rootPath: two })
    expect((await client.callTool({ name: 'read_file', arguments: { workspace_id: 'two', path: 'README.md' } })).isError).toBe(false)
    expect(toolFingerprint(catalog)).toBe(fp)
    entries = entries.filter((e) => e.id !== 'one')
    expect((await client.callTool({ name: 'read_file', arguments: { workspace_id: 'one', path: 'README.md' } })).isError).toBe(true)
    entries[0]!.permissions.read = false
    expect((await client.callTool({ name: 'read_file', arguments: { workspace_id: 'two', path: 'README.md' } })).isError).toBe(true)
    expect(toolFingerprint(catalog)).toBe(fp)
    config = { ...config, tools: { ...config.tools, git: false } }
    expect((await client.listTools()).tools.some((t) => t.name === 'git_status')).toBe(false)
    expect(toolFingerprint(catalog)).not.toBe(fp)
    expect(spawns).toBe(1); expect(kills).toBe(0)
    expect(provider.getStatus().pid).toBe(ready.pid)
    expect(provider.getStatus().endpoint?.connectorUrl).toBe(ready.endpoint?.connectorUrl)
    failProbe = true
    expect((await provider.diagnose()).status.phase).toBe('degraded')
    expect(kills).toBe(0)
    failProbe = false
    expect((await provider.diagnose()).status.phase).toBe('ready')
    await provider.stop()
    expect(ingress.getLocalUrl()).toBe(local)
  } finally { await client.close(); await provider.stop(); await ingress.stop(); rmSync(base, { recursive: true, force: true }) }
})

it('Given V10 scope 与新配置 When 迁移/比较 Then 不扩大旧范围并分类重启影响', () => {
  const migrated = normalizeRemoteConfig({ mode: 'cloudflare-quick', publicIngress: { workspaceIds: ['one'], port: 8787 } })
  expect(migrated.version).toBe(2); expect(migrated.publicIngress.scopeMode).toBe('custom'); expect(migrated.publicIngress.workspaceIds).toEqual(['one'])
  expect(normalizeRemoteConfig({ mode: 'local', autoStart: true }).enabled).toBe(false)
  const current = normalizeRemoteConfig({ version: 2 })
  expect(current.provider).toBeUndefined(); expect(current.publicIngress.scopeMode).toBe('inherit')
  expect(remoteApplyImpact(current, { ...current, autoStart: true })).toBe('none')
  expect(remoteApplyImpact(current, { ...current, publicIngress: { ...current.publicIngress, scopeMode: 'custom', workspaceIds: ['one'] } })).toBe('hot')
  expect(remoteApplyImpact(current, { ...current, publicIngress: { ...current.publicIngress, port: 8888 } })).toBe('ingress-restart')
})

it('Given External HTTPS When 运行检查 Then 不创建网络进程，失败为Degraded且可恢复', async () => {
  const ingress = new PublicMcpIngress({ list: () => [], call: async () => ({ content: [] }) }, () => 'x'.repeat(43), 'probe')
  await ingress.start(0)
  let spawns = 0; let fail = false
  const provider = new NetworkProvider('external-https', { hostname: 'https://external.example.com' }, ingress, () => 'x'.repeat(43), () => undefined, 'probe', () => undefined, {
    spawn: () => { spawns++; throw new Error('must not spawn') }, probe: async () => { if (fail) throw new Error('offline'); return { modern: true, toolCount: 2, workspaceList: true } },
  })
  try { expect((await provider.start()).phase).toBe('ready'); fail = true; expect((await provider.diagnose()).status.phase).toBe('degraded'); expect(spawns).toBe(0); fail = false; expect((await provider.diagnose()).status.phase).toBe('ready') }
  finally { await provider.stop(); await ingress.stop() }
})
