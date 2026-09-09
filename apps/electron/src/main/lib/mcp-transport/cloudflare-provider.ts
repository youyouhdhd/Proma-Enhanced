import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeTextFileAtomic } from '../safe-file'
import type { McpTransportStatus, McpTransportDiagnostic, PromaRemoteAccessConfig } from '@proma/shared'
import type { McpTransportProvider } from './types'
import type { PublicMcpIngress } from './public-ingress'
import { publicOrigin } from './config'
import { probePublicMcp } from './public-probe'

export function parseQuickUrl(output: string): string | undefined { return output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?![a-z0-9.-])/)?.[0] }
export function cloudflareArgs(kind: 'cloudflare-quick' | 'cloudflare-named', localUrl: string, configFile?: string): string[] {
  const prefix = ['tunnel', ...(configFile ? ['--config', configFile] : []), '--no-autoupdate']
  return kind === 'cloudflare-quick' ? [...prefix, '--url', localUrl, '--http-host-header', new URL(localUrl).host] : [...prefix, 'run']
}
export function cloudflareEnv(token?: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('TUNNEL_') || key.startsWith('CLOUDFLARE_')) delete env[key]
  delete env.CONTROL_PLANE_API_KEY; delete env.CONTROL_PLANE_HTTP_PROXY; delete env.PROMA_MCP_AUTH_HEADER
  if (token) env.TUNNEL_TOKEN = token
  return env
}
interface CloudflareDeps {
  spawn(executable: string, args: string[], options: SpawnOptions): ChildProcess
  version(executable: string): Promise<string>
  probe: typeof probePublicMcp
  timeoutMs: number
}
const defaults: CloudflareDeps = {
  spawn, probe: probePublicMcp, timeoutMs: 90_000,
  version: (executable) => new Promise((done, reject) => execFile(executable, ['--version'], { windowsHide: true, timeout: 5000, env: cloudflareEnv() }, (error, stdout) => {
    if (error || !/^cloudflared version \S+/i.test(stdout.trim())) reject(new Error('CLOUDFLARED_NOT_FOUND'))
    else done(stdout.trim().slice(0, 120))
  })),
}

/** Quick / Named 共用进程生命周期；差异仅为参数、URL 来源与 token。 */
export class CloudflareProvider implements McpTransportProvider {
  private status: McpTransportStatus
  private child?: ChildProcess
  private abort?: AbortController
  private epoch = 0
  private readonly deps: CloudflareDeps
  private baseUrl?: string
  private scratch?: string
  constructor(readonly kind: 'cloudflare-quick' | 'cloudflare-named', private readonly config: PromaRemoteAccessConfig,
    private readonly ingress: PublicMcpIngress, private readonly secret: () => string, private readonly token: () => string | undefined,
    private readonly marker: string, deps?: Partial<CloudflareDeps>) {
    this.status = { kind, phase: 'stopped' }; this.deps = { ...defaults, ...deps }
  }
  private executable(): string {
    if (this.config.cloudflare.executableMode === 'custom-path' && !this.config.cloudflare.customPath) throw new Error('CLOUDFLARED_NOT_FOUND')
    return this.config.cloudflare.executableMode === 'custom-path' ? this.config.cloudflare.customPath! : 'cloudflared'
  }
  getStatus(): McpTransportStatus { return { ...this.status, endpoint: this.status.endpoint ? { ...this.status.endpoint } : undefined, requests: this.ingress.getRequests() } }
  async preflight(): Promise<McpTransportStatus> {
    const version = await this.deps.version(this.executable())
    if (this.kind === 'cloudflare-named') {
      if (!this.token()) throw new Error('CLOUDFLARE_TUNNEL_TOKEN_MISSING')
      if (!this.config.cloudflare.hostname) throw new Error('CLOUDFLARE_NAMED_NOT_READY')
      publicOrigin(this.config.cloudflare.hostname)
    }
    return { kind: this.kind, phase: 'preflight', executableVersion: version }
  }
  async start(): Promise<McpTransportStatus> {
    await this.stop()
    const epoch = ++this.epoch
    const abort = new AbortController(); this.abort = abort
    this.status = { kind: this.kind, phase: 'preflight' }
    try {
      const preflight = await this.preflight()
      if (epoch !== this.epoch) return this.getStatus()
      this.status = preflight
      this.baseUrl = this.kind === 'cloudflare-named' ? publicOrigin(this.config.cloudflare.hostname!) : undefined
      this.ingress.setPublicOrigin(this.baseUrl)
      const localUrl = await this.ingress.start(this.config.publicIngress.port)
      if (epoch !== this.epoch) { await this.ingress.stop(); return this.getStatus() }
      this.status = { ...this.status, phase: 'starting', endpoint: { localUrl } }
      // 显式空配置隔离用户全局 ingress，避免旧 cloudflared 配置改写目标服务。
      this.scratch = mkdtempSync(join(tmpdir(), 'proma-cloudflare-'))
      const configFile = join(this.scratch, 'config.yml')
      writeTextFileAtomic(configFile, '{}\n')
      const child = this.deps.spawn(this.executable(), cloudflareArgs(this.kind, localUrl, configFile), {
        env: { ...cloudflareEnv(this.kind === 'cloudflare-named' ? this.token() : undefined), HOME: this.scratch, USERPROFILE: this.scratch }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child = child
      const fail = () => {
        if (epoch !== this.epoch) return
        this.status = { ...this.status, phase: 'error', errorCode: 'CLOUDFLARED_LAUNCH_FAILED', errorMessage: 'cloudflared 已退出，请检查程序、网络或 Named 配置。', probe: undefined }
        abort.abort(); void this.ingress.stop()
      }
      child.once('error', fail); child.once('exit', fail)
      let buffer = ''
      const decoder = new StringDecoder('utf8')
      const consume = (chunk: Buffer) => {
        buffer = (buffer + decoder.write(chunk)).slice(-8192)
        if (this.kind === 'cloudflare-quick' && !this.baseUrl) this.baseUrl = parseQuickUrl(buffer)
      }
      child.stdout?.on('data', consume); child.stderr?.on('data', consume)
      const deadline = Date.now() + this.deps.timeoutMs
      let code = this.kind === 'cloudflare-quick' ? 'CLOUDFLARE_PUBLIC_URL_NOT_FOUND' : 'CLOUDFLARE_NAMED_NOT_READY'
      while (Date.now() < deadline && !abort.signal.aborted && epoch === this.epoch) {
        if (this.baseUrl) {
          this.ingress.setPublicOrigin(this.baseUrl)
          this.status.endpoint = { localUrl, publicUrl: this.baseUrl, connectorUrl: this.baseUrl + '/mcp/••••••••' }
          try {
            const probe = await this.deps.probe(this.baseUrl + '/mcp/' + this.secret(), this.marker, abort.signal)
            if (abort.signal.aborted || epoch !== this.epoch || child.exitCode !== null) return this.getStatus()
            this.status = { ...this.status, phase: 'ready', probe, errorCode: undefined, errorMessage: undefined }
            return this.getStatus()
          } catch (error) { code = error instanceof Error && /^PUBLIC_MCP_[A-Z_]+$/.test(error.message) ? error.message : 'PUBLIC_MCP_UNREACHABLE' }
        }
        await new Promise<void>((done) => {
          const finish = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', finish); done() }
          const timer = setTimeout(finish, 500)
          abort.signal.addEventListener('abort', finish, { once: true })
        })
      }
      if (abort.signal.aborted || epoch !== this.epoch) return this.getStatus()
      throw new Error(code)
    } catch (error) {
      if (epoch !== this.epoch) return this.getStatus()
      await this.stop()
      const code = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : 'CLOUDFLARED_LAUNCH_FAILED'
      this.status = { kind: this.kind, phase: 'error', errorCode: code, errorMessage: '连接未就绪。检查 cloudflared、网络、域名路由和本地端口后重试。' }
      return this.getStatus()
    }
  }
  async stop(): Promise<void> {
    this.epoch++; this.abort?.abort(); this.abort = undefined
    this.baseUrl = undefined; this.status = { kind: this.kind, phase: 'stopped' }
    const child = this.child; this.child = undefined
    if (child && child.exitCode === null) child.kill()
    await this.ingress.stop()
    const scratch = this.scratch; this.scratch = undefined
    if (scratch) { try { if (realpathSync(scratch) === resolve(scratch)) rmSync(scratch, { recursive: true, force: true }) } catch { /* 子进程尚在退出时保留无凭据的临时空配置 */ } }
  }
  async diagnose(): Promise<McpTransportDiagnostic> {
    if (this.baseUrl && this.status.phase === 'ready') {
      try { this.status.probe = await this.deps.probe(this.baseUrl + '/mcp/' + this.secret(), this.marker, this.abort?.signal) }
      catch { await this.stop(); this.status = { kind: this.kind, phase: 'error', errorCode: 'PUBLIC_MCP_UNREACHABLE', errorMessage: '公网 MCP 复检失败，已停止连接。' } }
    }
    const status = this.getStatus()
    return { status, checks: [{ name: 'Public MCP 官方 Client', ok: status.phase === 'ready', detail: status.phase === 'ready' ? 'Modern、10 个只读工具和 workspace_list 已验证' : status.errorCode ?? '尚未启动' }] }
  }
}
