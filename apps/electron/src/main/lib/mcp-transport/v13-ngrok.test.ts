import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { RemoteProviderSettings, McpTransportStatus } from '@proma/shared'
import { NgrokProvider, ngrokInspector } from './ngrok-provider'
import { ngrokProfilePath, prepareNgrokProfile } from './ngrok-profile'
import { PublicMcpIngress } from './public-ingress'
import { normalizeRemoteConfig } from './config'
import { detectProviderBinary } from './provider-binary'
import { normalizeSharing } from '../mcp-sharing/config'
import { AnalysisTaskQueue } from '../mcp-sharing/task-queue'

const pass = { modern: true, toolCount: 18, workspaceList: true }
async function fixture(settings: RemoteProviderSettings = {}, scenario: 'launch' | 'reuse' | 'race' | 'conflict' | 'incomplete' = 'launch') {
  const base = mkdtempSync(join(tmpdir(), 'proma-ngrok-v13-'))
  const systemPath = join(base, 'system.yml'); writeFileSync(systemPath, 'system fixture unchanged')
  const ingress = new PublicMcpIngress({ list: () => [], call: async () => ({ content: [] }) }, () => 's'.repeat(43), 'marker')
  await ingress.start(0)
  let spawns = 0; let kills = 0; let probes = 0; let commands = 0
  let launchArgs: string[] = []; let launchEnv: NodeJS.ProcessEnv | undefined
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    kill: () => { kills++; child.emit('close', 0); return true } }) as unknown as ChildProcess
  const provider = new NgrokProvider({ mode: 'proma-managed', hostname: 'https://dedicated.ngrok.app', domainConfirmed: true, ...settings }, ingress,
    () => 's'.repeat(43), () => 'PRIVATE_FIXTURE_CREDENTIAL', 'marker', () => undefined, {
      profilePath: () => ngrokProfilePath(base), prepareProfile: () => prepareNgrokProfile(base), timeoutMs: 300,
      command: async (_file, args, env) => { commands++; expect(args).not.toContain('add-authtoken'); expect(env?.NGROK_AUTHTOKEN).toBe(settings.mode === 'system' || args[0] === 'version' ? undefined : 'PRIVATE_FIXTURE_CREDENTIAL'); return args[0] === 'version' ? 'ngrok version 3.39.9' : 'Valid configuration' },
      spawn: (_file, args, options) => {
        spawns++; launchArgs = args; launchEnv = options.env
        queueMicrotask(() => {
          child.stdout?.emit('data', Buffer.from('{"msg":"starting web service","addr":"127.0.0.1:4041"}\n'))
          if (scenario === 'race' || scenario === 'conflict') {
            child.stderr?.emit('data', Buffer.from('ERR_NGROK_334 endpoint already online\n'))
            child.emit('close', 1)
          }
        })
        return child
      },
      probe: async () => {
        probes++
        if (scenario === 'incomplete') return { ...pass, workspaceList: false }
        if (scenario === 'reuse' || scenario === 'race' && spawns > 0 || scenario === 'launch' && spawns > 0) return pass
        throw new Error('offline')
      },
    })
  return { base, provider, child, systemPath, snapshot: () => ({ spawns, kills, probes, commands, launchArgs, launchEnv }),
    cleanup: async () => { await provider.stop(); await ingress.stop(); rmSync(base, { recursive: true, force: true }) } }
}

describe('V13 Managed ngrok', () => {
  it('Given 系统配置与独立Credential When Managed启动/诊断/停止 Then 仅使用专用配置和env且诊断不改文件、不停止进程', async () => {
    const f = await fixture()
    try {
      const ready = await f.provider.start()
      expect(ready.phase).toBe('ready'); expect(ready.ngrok?.ownership).toBe('proma-process')
      expect(ready.ngrok?.inspectorUrl).toBe('http://127.0.0.1:4041')
      expect(f.snapshot().launchArgs).toContain(ngrokProfilePath(f.base))
      expect(f.snapshot().launchArgs.join(' ')).not.toContain('pooling')
      expect(f.snapshot().launchEnv?.NGROK_AUTHTOKEN).toBe('PRIVATE_FIXTURE_CREDENTIAL')
      const before = readFileSync(ngrokProfilePath(f.base), 'utf8')
      expect(before).not.toContain('PRIVATE'); expect(before).not.toContain('authtoken'); expect(before).not.toContain('s'.repeat(43))
      expect((await f.provider.diagnose()).status.phase).toBe('ready')
      expect(readFileSync(ngrokProfilePath(f.base), 'utf8')).toBe(before)
      expect(readFileSync(f.systemPath, 'utf8')).toBe('system fixture unchanged')
      expect(f.snapshot().kills).toBe(0)
      expect(JSON.stringify(ready)).not.toContain('PRIVATE_FIXTURE_CREDENTIAL')
      await f.provider.stop(); expect(f.snapshot().kills).toBe(1)
    } finally { await f.cleanup() }
  })
  for (const mode of ['proma-managed', 'system', 'external-existing'] as const) it(`Given 当前PROMA Endpoint When ${mode}预探测通过 Then 不spawn且停止不kill`, async () => {
    const f = await fixture({ mode }, 'reuse')
    try {
      const ready = await f.provider.start()
      expect(ready.phase).toBe('ready'); expect(ready.pid).toBeUndefined()
      expect(ready.ngrok?.ownership).toBe('existing-proma-endpoint')
      expect(f.snapshot().spawns).toBe(0); expect(f.snapshot().commands).toBe(0)
      expect(existsSync(ngrokProfilePath(f.base))).toBe(false)
      await f.provider.stop(); expect(f.snapshot().kills).toBe(0)
    } finally { await f.cleanup() }
  })
  for (const scenario of ['race', 'conflict'] as const) it(`Given ERR334 When 第二次探测${scenario} Then 安全复用或报告所有权冲突`, async () => {
    const f = await fixture({}, scenario)
    try {
      const state = await f.provider.start()
      expect(f.snapshot().probes).toBeGreaterThanOrEqual(2)
      expect(state.phase).toBe(scenario === 'race' ? 'ready' : 'error')
      expect(state.ngrok?.ownership).toBe(scenario === 'race' ? 'existing-proma-endpoint' : 'external-conflict')
      expect(state.errorCode).toBe(scenario === 'race' ? undefined : 'NGROK_ENDPOINT_CONFLICT')
      expect(f.snapshot().spawns).toBe(1); expect(f.snapshot().launchArgs.join(' ')).not.toContain('pooling')
      const kills = f.snapshot().kills; await f.provider.stop(); expect(f.snapshot().kills).toBe(kills)
    } finally { await f.cleanup() }
  })
  it('Given HTTP或不完整MCP响应 When Existing连接 Then 不Ready、不spawn', async () => {
    const f = await fixture({ mode: 'external-existing' }, 'incomplete')
    try { expect((await f.provider.start()).phase).toBe('error'); expect(f.snapshot().spawns).toBe(0) } finally { await f.cleanup() }
  })
  it('Given 未确认的迁移Domain When Managed首次启动 Then 提示确认且不spawn', async () => {
    const f = await fixture({ domainConfirmed: false })
    try { expect((await f.provider.start()).errorCode).toBe('NGROK_DOMAIN_CONFIRMATION_REQUIRED'); expect(f.snapshot().spawns).toBe(0) } finally { await f.cleanup() }
  })
  it('Given Inspector日志 When 解析 Then 仅接受真实loopback地址', () => {
    expect(ngrokInspector('{"msg":"starting web service","addr":"127.0.0.1:4041"}')).toBe('http://127.0.0.1:4041')
    for (const addr of ['0.0.0.0:4040', 'evil.example:4040', 'user@localhost:4040', 'localhost:4040/?token=secret']) expect(ngrokInspector(JSON.stringify({ msg: 'starting web service', addr }))).toBeUndefined()
  })
  it('Given 旧认证配置 When 迁移 Then 保留域名、不推断独占且不把自定义配置带入Managed', () => {
    for (const authSource of ['system-config', 'proma-secret'] as const) {
      const next = normalizeRemoteConfig({ version: 3, providers: { ngrok: { authSource, hostname: 'https://old.ngrok.app', configSource: 'custom', configPath: join(tmpdir(), 'old.yml') } } }).providers.ngrok!
      expect(next.mode).toBe(authSource === 'system-config' ? 'system' : 'proma-managed')
      expect(next.hostname).toBe('https://old.ngrok.app'); expect(next.domainConfirmed).toBe(false)
      if (authSource === 'proma-secret') expect(next.configPath).toBeUndefined()
    }
  })
  it('Given PATH程序和选错exe When 检测 Then 返回来源/版本且不要求Token或写配置', async () => {
    const valid = await detectProviderBinary('ngrok', undefined, async () => 'ngrok version 3.39.9')
    expect(valid.ok).toBe(true); expect(valid.source).toBe('path'); expect(valid.version).toContain('3.39.9')
    const invalid = await detectProviderBinary('ngrok', join(tmpdir(), 'wrong.exe'), async () => 'other version 1.2.3')
    expect(invalid.ok).toBe(false); expect(invalid.detail).toContain('NGROK_BINARY_INVALID')
  })
  it('Given queue=0 When 保存且并发满 Then 返回BUSY、无等待任务且空闲时可运行', async () => {
    const config = normalizeSharing({ version: 2, roots: [], delegation: { maxQueued: 0 } })
    expect(config.delegation.maxQueued).toBe(0)
    expect(normalizeSharing({ roots: [] }).delegation.maxQueued).toBe(3)
    for (const maxQueued of [-1, 21, 0.5]) expect(normalizeSharing({ roots: [], delegation: { maxQueued } }).delegation.maxQueued).toBe(3)
    let finish: (() => void) | undefined
    const queue = new AnalysisTaskQueue({ run: async () => { await new Promise<void>((resolve) => { finish = resolve }); return 'done' } }, () => undefined, () => undefined, [], () => config.delegation)
    queue.start('root', 'first')
    expect(() => queue.start('root', 'second')).toThrow('BUSY')
    await Promise.resolve()
    expect(queue.snapshot().filter((task) => task.status === 'queued')).toHaveLength(0)
    expect(() => queue.start('root', 'third')).toThrow('BUSY')
    finish!(); await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queue.start('root', 'fourth').id).toBeDefined()
    await Promise.resolve(); finish!(); await new Promise((resolve) => setTimeout(resolve, 0))
  })
  it('Given runtime-only程序 When 选择OpenAI程序 Then 缺少doctor/run即拒绝', async () => {
    const result = await detectProviderBinary('openai-secure', join(tmpdir(), 'tunnel-client.exe'), async (_file, args) => {
      if (args[0] !== '--version') throw new Error('unknown command')
      return 'tunnel-client 1.2.3'
    })
    expect(result.ok).toBe(false)
  })
  it('Given 预探测挂起 When 用户停止 Then 迟到成功不spawn也不恢复Ready', async () => {
    const ingress = new PublicMcpIngress({ list: () => [], call: async () => ({ content: [] }) }, () => 's'.repeat(43), 'marker')
    await ingress.start(0)
    let finish: ((value: NonNullable<McpTransportStatus['probe']>) => void) | undefined
    let spawned = false
    const provider = new NgrokProvider({ mode: 'external-existing', hostname: 'https://existing.ngrok.app' }, ingress, () => 's'.repeat(43), () => undefined, 'marker', () => undefined, {
      probe: () => new Promise((resolve) => { finish = resolve }), spawn: () => { spawned = true; throw new Error('unexpected') },
    })
    try {
      const pending = provider.start()
      while (!finish) await Promise.resolve()
      await provider.stop(); finish(pass)
      expect((await pending).phase).toBe('stopped'); expect(spawned).toBe(false)
    } finally { await provider.stop(); await ingress.stop() }
  })

  it('Given 公网先Ready随后收到334 When 进程退出 Then 仍验证并复用已有Endpoint', async () => {
    const f = await fixture()
    try {
      expect((await f.provider.start()).phase).toBe('ready')
      f.child.stderr?.emit('data', Buffer.from('ERR_NGROK_334 endpoint already online\n'))
      f.child.emit('close', 1)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const state = f.provider.getStatus()
      expect(state.phase).toBe('ready'); expect(state.ngrok?.ownership).toBe('existing-proma-endpoint'); expect(state.pid).toBeUndefined()
      const kills = f.snapshot().kills
      f.child.emit('close', 1)
      expect(f.provider.getStatus().phase).toBe('ready')
      await f.provider.stop(); expect(f.snapshot().kills).toBe(kills)
    } finally { await f.cleanup() }
  })

  it('Given 尚未启动的Managed配置 When 运行诊断 Then 不创建Profile、不spawn且不kill', async () => {
    const f = await fixture()
    try {
      const result = await f.provider.diagnose()
      expect(result.status.phase).toBe('stopped')
      expect(existsSync(ngrokProfilePath(f.base))).toBe(false)
      expect(f.snapshot().spawns).toBe(0); expect(f.snapshot().kills).toBe(0)
      expect(readFileSync(f.systemPath, 'utf8')).toBe('system fixture unchanged')
    } finally { await f.cleanup() }
  })

})
