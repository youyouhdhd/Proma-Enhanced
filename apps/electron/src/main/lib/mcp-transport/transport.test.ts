import { describe, it, expect } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { CloudflareProvider, cloudflareArgs, cloudflareEnv, parseQuickUrl } from './cloudflare-provider'
import { normalizeRemoteConfig, publicOrigin } from './config'
import { PublicMcpIngress } from './public-ingress'
import { TransportSecretStore } from './secret-store'
import { TunnelProcessRunner } from '../mcp-server/tunnel-process-runner'

const secret = 'a'.repeat(43)
async function fixture(kind: 'cloudflare-quick' | 'cloudflare-named', token?: string, options: { exit?: boolean; noUrl?: boolean; version?: () => Promise<string>; probeFail?: boolean } = {}) {
  const config = normalizeRemoteConfig({ mode: kind, cloudflare: { hostname: 'https://public.example.com' } })
  config.publicIngress.port = 0
  const ingress = new PublicMcpIngress({ list: () => [], call: async () => ({ content: [] }) }, () => secret, 'marker')
  await ingress.start(0)
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: () => true }) as unknown as ChildProcess
  child.kill = () => { child.emit('exit', 0); return true }
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = []
  const provider = new CloudflareProvider(kind, config, ingress, () => secret, () => token, 'marker', {
    version: options.version ?? (async () => 'cloudflared version test'), timeoutMs: 700,
    spawn: (_exe, args, opts) => { calls.push({ args, env: opts.env }); queueMicrotask(() => {
      if (options.exit) child.emit('exit', 1)
      else if (!options.noUrl) child.stderr?.emit('data', Buffer.from('url https://test-fixture.trycloudflare.com'))
    }); return child },
    probe: async () => { if (options.probeFail) throw new Error('PUBLIC_MCP_TOOL_DISCOVERY_FAILED'); return { modern: true, toolCount: 10, workspaceList: true } },
  })
  return { provider, child, calls, ingress }
}

describe('V10 Transport', () => {
  it('Given Quick CLI output When URL arrives Then 官方探测通过才 Ready，状态不含 Secret', async () => {
    const { provider, child, ingress } = await fixture('cloudflare-quick')
    try {
      const status = await provider.start()
      expect(status.phase).toBe('ready')
      expect(status.endpoint?.connectorUrl).toContain('••••')
      expect(JSON.stringify(status)).not.toContain(secret)
      child.emit('exit', 1)
      expect(provider.getStatus().phase).toBe('error')
      expect(provider.getStatus().probe).toBeUndefined()
    } finally { await provider.stop(); await ingress.stop() }
  })
  it('Given Named When start Then Token 只在 env，域名稳定', async () => {
    const { provider, calls, ingress } = await fixture('cloudflare-named', 'never-log-token')
    try {
      const first = await provider.start()
      expect(first.phase).toBe('ready')
      expect(first.endpoint?.publicUrl).toBe('https://public.example.com')
      expect(calls[0]?.env?.TUNNEL_TOKEN).toBe('never-log-token')
      expect(calls[0]?.args).not.toContain('never-log-token')
      expect(JSON.stringify(first)).not.toContain('never-log-token')
      await provider.stop()
      expect((await provider.start()).endpoint?.connectorUrl).toBe(first.endpoint?.connectorUrl)
    } finally { await provider.stop(); await ingress.stop() }
  })
  it('Given 缺程序/缺 Token/无 URL/退出/探测失败 When start Then 错误不标 Ready', async () => {
    for (const [kind, opts, expected] of [
      ['cloudflare-quick', { version: async () => { throw new Error('CLOUDFLARED_NOT_FOUND') } }, 'CLOUDFLARED_NOT_FOUND'],
      ['cloudflare-named', {}, 'CLOUDFLARE_TUNNEL_TOKEN_MISSING'],
      ['cloudflare-quick', { noUrl: true }, 'CLOUDFLARE_PUBLIC_URL_NOT_FOUND'],
      ['cloudflare-quick', { exit: true }, 'CLOUDFLARED_LAUNCH_FAILED'],
      ['cloudflare-quick', { probeFail: true }, 'PUBLIC_MCP_TOOL_DISCOVERY_FAILED'],
    ] as const) {
      const { provider, ingress } = await fixture(kind, undefined, opts)
      try { const status = await provider.start(); expect(status.phase).toBe('noUrl' in opts || 'probeFail' in opts ? 'degraded' : 'error'); expect(status.errorCode).toBe(expected) }
      finally { await provider.stop(); await ingress.stop() }
    }
  })
  it('Given start 正在 preflight When stop Then 迟到结果不会复活连接', async () => {
    let finish: (value: string) => void = () => undefined
    const pending = new Promise<string>((resolve) => { finish = resolve })
    const { provider, ingress } = await fixture('cloudflare-quick', undefined, { version: () => pending })
    const starting = provider.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await provider.stop(); finish('cloudflared version test'); await starting
    expect(provider.getStatus().phase).toBe('stopped')
    await ingress.stop()
  })
  it('Given 不可信配置 When normalize Then 固定只读、拒绝凭据 URL/无效端口，Proxy 只影响 OpenAI', () => {
    expect(parseQuickUrl('x https://abc-def.trycloudflare.com y')).toBe('https://abc-def.trycloudflare.com')
    expect(parseQuickUrl('https://evil.example.com')).toBeUndefined()
    expect(parseQuickUrl('https://abc.trycloudflare.com.evil.com')).toBeUndefined()
    expect(normalizeRemoteConfig({}).enabled).toBe(false)
    expect(normalizeRemoteConfig({ version: 2 }).publicIngress.scopeMode).toBe('inherit')
    expect(() => normalizeRemoteConfig({ publicIngress: { port: 0 } })).toThrow()
    for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/mcp/key', 'https://example.com?token=x', 'https://192.168.1.1', 'https://[::ffff:127.0.0.1]']) expect(() => publicOrigin(url)).toThrow()
    expect(cloudflareArgs('cloudflare-named', 'http://127.0.0.1:8787')).toEqual(['tunnel', '--no-autoupdate', 'run'])
    expect(cloudflareEnv().TUNNEL_TOKEN).toBeUndefined()
    const env = new TunnelProcessRunner().buildTunnelClientEnv({ runtimeKey: 'rk', controlPlaneProxy: 'http://127.0.0.1:7890' })
    expect(env.CONTROL_PLANE_HTTP_PROXY).toBe('http://127.0.0.1:7890'); expect(env.NO_PROXY).toContain('127.0.0.1'); expect(env.NO_PROXY).toContain('localhost')
  })
  it('Given 加密存储 When 重建实例与轮换 Then Secret 稳定、密文持久化且解密失败不重置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-secret-test-'))
    const key = randomBytes(32)
    const codec = { isEncryptionAvailable: () => true,
      encryptString: (s: string) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(s), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]) },
      decryptString: (b: Buffer) => { const cipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); cipher.setAuthTag(b.subarray(12, 28)); return Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString() },
    }
    try {
      const store = new TransportSecretStore(dir, codec)
      const first = store.ensureConnector()
      expect(first.length).toBeGreaterThanOrEqual(43)
      expect(new TransportSecretStore(dir, codec).ensureConnector()).toBe(first)
      expect(readFileSync(join(dir, 'mcp-transport-connector'), 'utf8')).not.toContain(first)
      expect(store.rotateConnector()).not.toBe(first)
      expect(() => new TransportSecretStore(dir, { ...codec, decryptString: () => { throw new Error() } }).ensureConnector()).toThrow('TRANSPORT_SECRET_UNREADABLE')
      expect(() => new TransportSecretStore(dir, { ...codec, isEncryptionAvailable: () => false }).save('cloudflare', 'token')).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
