import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { McpTransportStatus, McpTransportDiagnostic, RemoteProviderSettings } from '@proma/shared'
import type { McpTransportProvider } from './types'
import type { PublicMcpIngress } from './public-ingress'
import { publicOrigin } from './config'
import { probePublicMcp } from './public-probe'
import { writeTextFileAtomic } from '../safe-file'

export function runProviderCommand(executable: string, args: string[]): Promise<string> {
  return new Promise((done, reject) => execFile(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024 }, (error, out, err) => {
    if (error && !args.includes('--help')) reject(new Error('PROVIDER_COMMAND_FAILED'))
    else done(out + err)
  }))
}
interface NetworkDeps { command: typeof runProviderCommand; spawn(file: string, args: string[], options: SpawnOptions): ChildProcess; probe: typeof probePublicMcp; timeoutMs: number }
export class NetworkProvider implements McpTransportProvider {
  private state: McpTransportStatus
  private child?: ChildProcess
  private abort?: AbortController
  private epoch = 0
  private origin?: string
  private scratch?: string
  private readonly deps: NetworkDeps
  constructor(readonly kind: 'external-https' | 'ngrok' | 'tailscale-funnel', private readonly settings: RemoteProviderSettings,
    private readonly ingress: PublicMcpIngress, private readonly secret: () => string, private readonly token: () => string | undefined,
    private readonly marker: string, private readonly changed: () => void, deps?: Partial<NetworkDeps>) {
    this.state = { kind, phase: 'stopped' }; this.deps = { command: runProviderCommand, spawn, probe: probePublicMcp, timeoutMs: 90000, ...deps }
  }
  private executable(): string { return this.settings.executablePath ?? (this.kind === 'ngrok' ? 'ngrok' : 'tailscale') }
  getStatus(): McpTransportStatus { return { ...this.state, requests: this.ingress.getRequests() } }
  async preflight(): Promise<McpTransportStatus> {
    if (this.kind === 'external-https') { if (!this.settings.hostname) throw new Error('PUBLIC_HOSTNAME_REQUIRED'); this.origin = publicOrigin(this.settings.hostname); return { kind: this.kind, phase: 'preflight' } }
    const executable = this.executable()
    const version = await this.deps.command(executable, ['version'])
    const help = await this.deps.command(executable, [this.kind === 'ngrok' ? 'http' : 'funnel', '--help'])
    if (this.kind === 'ngrok') {
      if (!help.includes('--url') || !help.includes('--config')) throw new Error('PROVIDER_CLI_UNSUPPORTED')
      if (!this.token()) throw new Error('NGROK_TOKEN_MISSING')
      if (!this.settings.hostname) throw new Error('NGROK_DOMAIN_REQUIRED')
      this.origin = publicOrigin(this.settings.hostname)
    } else {
      if (!help.includes('--https')) throw new Error('PROVIDER_CLI_UNSUPPORTED')
      const status = JSON.parse(await this.deps.command(executable, ['status', '--json'])) as { BackendState?: string; Self?: { DNSName?: string } }
      if (status.BackendState !== 'Running' || !status.Self?.DNSName) throw new Error('TAILSCALE_LOGIN_REQUIRED')
      const dns = status.Self.DNSName.replace(/\.$/, '')
      if (!/^[a-z0-9.-]+\.ts\.net$/i.test(dns)) throw new Error('TAILSCALE_DNS_UNAVAILABLE')
      this.origin = publicOrigin('https://' + dns)
      const existing = JSON.parse(await this.deps.command(executable, ['funnel', 'status', '--json'])) as { Web?: Record<string, unknown>; TCP?: Record<string, unknown>; Foreground?: Record<string, unknown> }
      if (existing.TCP?.['443'] !== undefined || Object.keys(existing.Web ?? {}).some((key) => key.endsWith(':443')) || Object.keys(existing.Foreground ?? {}).length) throw new Error('TAILSCALE_FUNNEL_ALREADY_CONFIGURED')
    }
    return { kind: this.kind, phase: 'preflight', executableVersion: version.trim().split('\n')[0]?.slice(0, 100) }
  }
  async start(): Promise<McpTransportStatus> {
    await this.stop(); const epoch = ++this.epoch; this.abort = new AbortController(); const signal = this.abort.signal
    this.state = { kind: this.kind, phase: 'preflight' }; this.changed()
    try {
      const ready = await this.preflight()
      if (epoch !== this.epoch) return this.getStatus()
      const local = this.ingress.getLocalUrl()
      if (!local || !this.origin) throw new Error('REMOTE_INGRESS_NOT_READY')
      this.ingress.setPublicOrigin(this.origin)
      this.state = { ...ready, phase: 'starting', endpoint: { localUrl: local, publicUrl: this.origin, connectorUrl: this.origin + '/mcp/••••••••' } }; this.changed()
      if (this.kind !== 'external-https') {
        const env = { ...process.env }
        delete env.NGROK_AUTHTOKEN; delete env.CONTROL_PLANE_API_KEY; delete env.PROMA_MCP_AUTH_HEADER
        delete env.TUNNEL_TOKEN; delete env.TUNNEL_TOKEN_FILE; delete env.CONTROL_PLANE_HTTP_PROXY
        let args: string[]
        if (this.kind === 'ngrok') {
          this.scratch = mkdtempSync(join(tmpdir(), 'proma-ngrok-'))
          const file = join(this.scratch, 'ngrok.yml'); writeTextFileAtomic(file, 'version: "3"\nagent:\n  web_addr: false\n')
          env.NGROK_AUTHTOKEN = this.token()
          args = ['http', local, '--url', this.origin, '--config', file, '--log', 'stdout', '--log-format', 'json']
        } else args = ['funnel', '--https=443', local]
        const child = this.deps.spawn(this.executable(), args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        this.child = child; this.state.pid = child.pid
        child.stdout?.on('data', () => undefined); child.stderr?.on('data', () => undefined)
        const fatal = () => { if (epoch !== this.epoch) return; this.state = { ...this.state, phase: 'error', errorCode: 'PROVIDER_PROCESS_EXITED', probe: undefined }; this.abort?.abort(); this.changed() }
        child.once('exit', fatal); child.once('error', fatal)
      }
      const deadline = Date.now() + this.deps.timeoutMs
      while (!signal.aborted && Date.now() < deadline) {
        try {
          const probe = await this.deps.probe(this.origin + '/mcp/' + this.secret(), this.marker, signal)
          if (epoch !== this.epoch || signal.aborted) return this.getStatus()
          this.state = { ...this.state, phase: 'ready', probe }; this.changed(); return this.getStatus()
        } catch { if (this.kind === 'external-https') break; await new Promise((done) => setTimeout(done, 500)) }
      }
      if (epoch === this.epoch && !signal.aborted) { this.state = { ...this.state, phase: 'degraded', errorCode: 'PUBLIC_MCP_UNREACHABLE', errorMessage: '检查未通过，进程保留；请核对账号、权限、固定域名及代理目标。' }; this.changed() }
    } catch (error) {
      if (epoch === this.epoch) { this.state = { kind: this.kind, phase: 'error', errorCode: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'PROVIDER_PREFLIGHT_FAILED' }; this.changed() }
    }
    return this.getStatus()
  }
  async stop(): Promise<void> {
    this.epoch++; this.abort?.abort(); this.abort = undefined
    this.child?.kill(); this.child = undefined
    if (this.scratch) { try { rmSync(this.scratch, { recursive: true, force: true }) } catch { /* 无凭据临时配置 */ } this.scratch = undefined }
    this.origin = undefined; this.state = { kind: this.kind, phase: 'stopped' }; this.changed()
  }
  async diagnose(): Promise<McpTransportDiagnostic> {
    const epoch = this.epoch
    if (this.origin && ['ready', 'degraded'].includes(this.state.phase)) {
      try { const probe = await this.deps.probe(this.origin + '/mcp/' + this.secret(), this.marker, this.abort?.signal); if (epoch === this.epoch) this.state = { ...this.state, phase: 'ready', probe, errorCode: undefined, errorMessage: undefined } }
      catch { if (epoch === this.epoch) this.state = { ...this.state, phase: 'degraded', errorCode: 'PUBLIC_MCP_UNREACHABLE', errorMessage: '本次检查失败，连接保持运行。' } }
      this.changed()
    }
    return { status: this.getStatus(), checks: [{ name: '公网官方 MCP Client', ok: this.state.phase === 'ready', detail: this.state.phase }] }
  }
}
