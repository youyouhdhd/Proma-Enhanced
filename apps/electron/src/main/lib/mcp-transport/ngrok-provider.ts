import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { McpTransportStatus, McpTransportDiagnostic, RemoteProviderSettings } from '@proma/shared'
import type { McpTransportProvider } from './types'
import type { PublicMcpIngress } from './public-ingress'
import { publicOrigin } from './config'
import { probePublicMcp } from './public-probe'
import { ProviderLogBuffer, redactProviderText } from './provider-log-buffer'
import { ProviderCommandError, runProviderCommand, stopProviderProcess } from './provider-process-runner'

interface NgrokDeps {
  command: typeof runProviderCommand
  spawn(file: string, args: string[], options: SpawnOptions): ChildProcess
  probe: typeof probePublicMcp
  timeoutMs: number
}

export function ngrokErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/ERR_NGROK_9009/i.test(message)) return 'NGROK_PROXY_PLAN_REQUIRED'
  if (error instanceof ProviderCommandError && error.exitCode === 'ENOENT') return 'NGROK_BINARY_NOT_FOUND'
  if (/ERR_NGROK_334|already.*online/i.test(message)) return 'NGROK_ENDPOINT_ALREADY_ONLINE'
  if (/ERR_NGROK_108|ERR_NGROK_105|ERR_NGROK_4018|authentication failed|invalid authtoken/i.test(message)) return 'NGROK_AUTH_FAILED'
  if (/ERR_NGROK_15013|domain.*(?:unavailable|reserved|not found)/i.test(message)) return 'NGROK_DOMAIN_UNAVAILABLE'
  return /^NGROK_[A-Z_]+$/.test(message) ? message : 'NGROK_PROCESS_EXITED'
}

/** 一个进程对应一个 Connector，项目注册表完全由共同 Ingress 持有。 */
export class NgrokProvider implements McpTransportProvider {
  readonly kind = 'ngrok' as const
  private state: McpTransportStatus = { kind: 'ngrok', phase: 'stopped' }
  private child?: ChildProcess
  private abort?: AbortController
  private epoch = 0
  private origin?: string
  private readonly deps: NgrokDeps
  private readonly logs: ProviderLogBuffer
  constructor(private readonly settings: RemoteProviderSettings, private readonly ingress: PublicMcpIngress,
    private readonly secret: () => string, private readonly token: () => string | undefined,
    private readonly marker: string, private readonly changed: () => void, deps?: Partial<NgrokDeps>) {
    this.deps = { command: runProviderCommand, spawn, probe: probePublicMcp, timeoutMs: 90000, ...deps }
    this.logs = new ProviderLogBuffer('ngrok', () => [secret(), token() ?? ''], changed)
  }
  private executable(): string { return this.settings.executablePath ?? 'ngrok' }
  private configArgs(): string[] {
    if (this.settings.configSource !== 'custom') return []
    if (!this.settings.configPath) throw new Error('NGROK_CONFIG_INVALID')
    return ['--config', this.settings.configPath]
  }
  private env(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    for (const name of ['NGROK_AUTHTOKEN', 'CONTROL_PLANE_API_KEY', 'PROMA_MCP_AUTH_HEADER', 'TUNNEL_TOKEN', 'TUNNEL_TOKEN_FILE', 'CONTROL_PLANE_HTTP_PROXY']) delete env[name]
    // Proma 的通用 HTTP 代理不应隐式启用 ngrok 付费 agent proxy 功能。
    // 用户在 ngrok.yml 中明确配置的 proxy_url 仍由 ngrok 自己处理。
    for (const name of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(name)) delete env[name]
    if (this.settings.authSource === 'proma-secret') {
      const token = this.token(); if (!token) throw new Error('NGROK_AUTH_MISSING')
      env.NGROK_AUTHTOKEN = token
    }
    return env
  }
  getStatus(): McpTransportStatus { return { ...this.state, stableUrl: this.settings.endpointMode !== 'auto-domain', logs: this.logs.snapshot(), requests: this.ingress.getRequests() } }
  clearLogs(): void { this.logs.clear() }
  async preflight(): Promise<McpTransportStatus> {
    let version: string
    const env = this.env()
    try { version = await this.deps.command(this.executable(), ['version'], env) }
    catch (error) { this.logs.add('command', error instanceof Error ? error.message : '版本检查失败', 'error'); throw error instanceof ProviderCommandError && error.exitCode === 'ENOENT' ? error : new Error('NGROK_VERSION_FAILED') }
    this.logs.add('command', version.trim())
    try {
      const config = await this.deps.command(this.executable(), ['config', 'check', ...this.configArgs()], this.env())
      this.logs.add('command', config)
    } catch (error) { this.logs.add('command', error instanceof Error ? error.message : '配置无效', 'error'); throw new Error('NGROK_CONFIG_INVALID') }
    this.logs.add('system', '配置有效；云端认证将在启动后验证。')
    if (this.settings.endpointMode !== 'auto-domain') {
      if (!this.settings.hostname) throw new Error('NGROK_DOMAIN_REQUIRED')
      try { this.origin = publicOrigin(this.settings.hostname) } catch { throw new Error('NGROK_DOMAIN_INVALID') }
    }
    return { kind: this.kind, phase: 'preflight', executableVersion: version.trim().split('\n')[0]?.slice(0, 100) }
  }
  async start(): Promise<McpTransportStatus> {
    await this.stop()
    const epoch = ++this.epoch; const abort = new AbortController(); this.abort = abort
    this.state = { kind: this.kind, phase: 'preflight' }; this.changed()
    try {
      const checked = await this.preflight()
      if (epoch !== this.epoch) return this.getStatus()
      const local = this.ingress.getLocalUrl(); if (!local) throw new Error('NGROK_LOCAL_INGRESS_UNAVAILABLE')
      this.state = { ...checked, phase: 'starting', endpoint: { localUrl: local } }
      const setOrigin = (origin: string) => {
        this.origin = origin; this.ingress.setPublicOrigin(origin)
        this.state.endpoint = { localUrl: local, publicUrl: origin, connectorUrl: origin + '/mcp/••••••••' }; this.changed()
      }
      if (this.origin) setOrigin(this.origin)
      const args = ['http', local, ...(this.origin ? ['--url', this.origin] : []), ...this.configArgs(), '--log', 'stdout', '--log-format', 'json', ...(this.settings.webInspector === 'disabled' ? ['--inspect=false'] : [])]
      this.logs.add('command', [this.executable(), ...args].join(' '))
      const child = this.deps.spawn(this.executable(), args, { env: this.env(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child; this.state.pid = child.pid
      const observe = (line: string) => {
        if (epoch !== this.epoch) return
        if (/ERR_NGROK_/.test(line)) { this.state.errorCode = ngrokErrorCode(new Error(line)); this.state.errorMessage = redactProviderText(line, [this.secret(), this.token() ?? '']).slice(-1000) }
        if (!this.origin && this.settings.endpointMode === 'auto-domain') {
          try {
            const event = JSON.parse(line) as { url?: string; msg?: string }
            if (event.msg === 'started tunnel' && event.url?.startsWith('https://')) setOrigin(publicOrigin(event.url))
          } catch { /* 非 JSON 进程输出仍保留在安全日志中 */ }
        }
      }
      this.logs.attach(child.stdout, 'stdout', observe); this.logs.attach(child.stderr, 'stderr', observe)
      const exited = () => { if (epoch !== this.epoch) return; this.state = { ...this.state, phase: 'error', errorCode: this.state.errorCode ?? 'NGROK_PROCESS_EXITED' }; abort.abort(); this.logs.add('system', 'ngrok 进程退出，保留此前日志。', 'error'); this.changed() }
      child.once('exit', exited); child.once('error', exited)
      const deadline = Date.now() + this.deps.timeoutMs
      while (!abort.signal.aborted && Date.now() < deadline) {
        if (this.origin) {
          try {
            const probe = await this.deps.probe(this.origin + '/mcp/' + this.secret(), this.marker, abort.signal)
            if (epoch !== this.epoch || abort.signal.aborted) return this.getStatus()
            this.state = { ...this.state, phase: 'ready', probe, errorCode: undefined, errorMessage: undefined }
            this.logs.add('probe', `公网 MCP 通过，工具 ${probe.toolCount} 个`); this.changed(); return this.getStatus()
          } catch { /* 启动阶段重试，最终失败保持进程 */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      if (epoch === this.epoch && !abort.signal.aborted) { this.state.phase = 'degraded'; this.state.errorCode ??= 'NGROK_MCP_PROBE_FAILED'; this.logs.add('probe', '公网检查未通过。检查账号、域名及日志，连接进程保留。', 'warn'); this.changed() }
    } catch (error) {
      if (epoch === this.epoch) {
        this.logs.add('system', error instanceof Error ? error.message : '启动失败', 'error')
        this.state = { ...this.state, phase: 'error', errorCode: ngrokErrorCode(error), errorMessage: this.logs.snapshot().at(-1)?.text }; this.changed()
      }
    }
    return this.getStatus()
  }
  async stop(): Promise<void> {
    this.epoch++; this.abort?.abort(); this.abort = undefined
    const child = this.child; this.child = undefined; await stopProviderProcess(child); this.origin = undefined
    this.state = { kind: this.kind, phase: 'stopped' }; this.changed()
  }
  async diagnose(): Promise<McpTransportDiagnostic> {
    const epoch = this.epoch
    if (this.origin && ['ready', 'degraded'].includes(this.state.phase)) {
      try {
        const probe = await this.deps.probe(this.origin + '/mcp/' + this.secret(), this.marker, this.abort?.signal)
        if (epoch === this.epoch) this.state = { ...this.state, phase: 'ready', probe, errorCode: undefined, errorMessage: undefined }
      } catch { if (epoch === this.epoch) this.state = { ...this.state, phase: 'degraded', errorCode: 'NGROK_PUBLIC_UNREACHABLE' } }
      this.logs.add('probe', this.state.phase === 'ready' ? '公网检查通过' : '公网检查失败，进程保留'); this.changed()
    }
    return { status: this.getStatus(), checks: [{ name: 'ngrok 公网 MCP', ok: this.state.phase === 'ready', detail: this.state.errorCode ?? this.state.phase }] }
  }
}
