import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { McpTransportStatus, McpTransportDiagnostic, RemoteProviderSettings, NgrokRuntimeState } from '@proma/shared'
import type { McpTransportProvider } from './types'
import type { PublicMcpIngress } from './public-ingress'
import { publicOrigin } from './config'
import { probePublicMcp } from './public-probe'
import { ProviderLogBuffer, redactProviderText } from './provider-log-buffer'
import { ProviderCommandError, runProviderCommand, stopProviderProcess } from './provider-process-runner'
import { ngrokMode, ngrokConfig, ngrokEnvironment, ngrokProfilePath, prepareNgrokProfile } from './ngrok-profile'
import { detectProviderBinary } from './provider-binary'

interface NgrokDeps {
  command: typeof runProviderCommand
  spawn(file: string, args: string[], options: SpawnOptions): ChildProcess
  probe: typeof probePublicMcp
  prepareProfile(): string
  profilePath(): string
  timeoutMs: number
}

export function ngrokErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/ERR_NGROK_9009/i.test(message)) return 'NGROK_PROXY_PLAN_REQUIRED'
  if (error instanceof ProviderCommandError && error.exitCode === 'ENOENT') return 'NGROK_BINARY_NOT_FOUND'
  if (/ERR_NGROK_334|already.*online/i.test(message)) return 'NGROK_ENDPOINT_CONFLICT'
  if (/ERR_NGROK_108|ERR_NGROK_105|ERR_NGROK_4018|authentication failed|invalid authtoken/i.test(message)) return 'NGROK_AUTH_FAILED'
  if (/ERR_NGROK_15013|domain.*(?:unavailable|reserved|not found)/i.test(message)) return 'NGROK_DOMAIN_UNAVAILABLE'
  return /^NGROK_[A-Z_]+$/.test(message) ? message : 'NGROK_PROCESS_EXITED'
}

export function ngrokInspector(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as { msg?: string; addr?: string }
    if (event.msg !== 'starting web service' || typeof event.addr !== 'string') return
    const url = new URL(event.addr.includes('://') ? event.addr : 'http://' + event.addr)
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin
  } catch { /* 非 JSON 日志仍保留，绝不从任意日志打开外部地址。 */ }
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
    this.deps = { command: runProviderCommand, spawn, probe: probePublicMcp, prepareProfile: prepareNgrokProfile, profilePath: ngrokProfilePath, timeoutMs: 90000, ...deps }
    this.logs = new ProviderLogBuffer('ngrok', () => [secret(), ngrokMode(settings) === 'proma-managed' ? token() ?? '' : ''], changed)
  }
  private runtime(): NgrokRuntimeState {
    const mode = ngrokMode(this.settings)
    return { mode, ownership: 'none', credentialSource: mode === 'external-existing' ? 'external' : mode === 'proma-managed' ? 'proma-secret' : 'system-config' }
  }
  private executable(): string { return this.settings.executablePath ?? 'ngrok' }
  private configArgs(): string[] {
    const config = ngrokConfig(this.settings, this.deps.profilePath())
    if (config.source === 'custom' && !config.path) throw new Error('NGROK_CONFIG_INVALID')
    return config.path ? ['--config', config.path] : []
  }
  private env(): NodeJS.ProcessEnv { return ngrokEnvironment(this.settings, ngrokMode(this.settings) === 'proma-managed' ? this.token() : undefined) }
  getStatus(): McpTransportStatus {
    return { ...this.state, ngrok: { ...(this.state.ngrok ?? this.runtime()) }, stableUrl: ngrokMode(this.settings) === 'external-existing' || this.settings.endpointMode !== 'auto-domain', logs: this.logs.snapshot(), requests: this.ingress.getRequests() }
  }
  clearLogs(): void { this.logs.clear() }
  async preflight(): Promise<McpTransportStatus> {
    const runtime = this.runtime()
    if (runtime.mode === 'external-existing') return { kind: this.kind, phase: 'preflight', ngrok: runtime }
    const binary = await detectProviderBinary('ngrok', this.settings.executablePath, this.deps.command)
    if (!binary.ok) throw new Error('NGROK_BINARY_INVALID')
    const config = ngrokConfig(this.settings, this.deps.profilePath())
    try {
      const output = await this.deps.command(this.executable(), ['config', 'check', ...this.configArgs()], this.env())
      // 系统文件只让 ngrok 自检，绝不读取或回传文件中的 Authtoken。
      config.valid = true
      if (!config.path) config.path = output.match(/Valid configuration file at\s+([^\r\n]+)/i)?.[1]?.trim()
    } catch (error) {
      config.valid = false
      this.logs.add('command', error instanceof Error ? error.message : 'ngrok 配置检查失败', 'error')
    }
    if (runtime.mode === 'proma-managed') config.authConfigured = Boolean(this.token())
    return { kind: this.kind, phase: 'preflight', binary, executableVersion: binary.version, ngrok: { ...runtime, config } }
  }
  private async checkEndpoint(signal: AbortSignal): Promise<NonNullable<McpTransportStatus['probe']>> {
    if (!this.origin || !this.secret()) throw new Error('NGROK_DOMAIN_REQUIRED')
    const probe = await this.deps.probe(this.origin + '/mcp/' + this.secret(), this.marker, signal)
    if (!probe.modern || !probe.workspaceList || probe.toolCount < 1) throw new Error('NGROK_MCP_PROBE_FAILED')
    return probe
  }
  private ready(probe: NonNullable<McpTransportStatus['probe']>, reused: boolean): void {
    this.state = { ...this.state, phase: 'ready', probe, pid: reused ? undefined : this.child?.pid,
      ngrok: { ...(this.state.ngrok ?? this.runtime()), ownership: reused ? 'existing-proma-endpoint' : 'proma-process', credentialSource: reused ? 'external' : this.runtime().credentialSource }, errorCode: undefined, errorMessage: undefined }
    this.logs.add('probe', reused ? '已验证当前 PROMA Endpoint；复用连接，PROMA 不管理外部进程。' : `公网 MCP 通过，工具 ${probe.toolCount} 个`)
    this.changed()
  }
  private async recoverConflict(epoch: number, signal: AbortSignal): Promise<void> {
    const current = () => epoch === this.epoch && !signal.aborted
    const owned = this.child; this.child = undefined
    await stopProviderProcess(owned)
    if (!current()) return
    try {
      const probe = await this.checkEndpoint(signal)
      if (current()) this.ready(probe, true)
    } catch {
      if (!current()) return
      this.state = { ...this.state, phase: 'error', pid: undefined, probe: undefined,
        ngrok: { ...this.state.ngrok!, ownership: 'external-conflict' }, errorCode: 'NGROK_ENDPOINT_CONFLICT',
        errorMessage: '当前地址未通过 PROMA MCP 验证，请配置另一个 PROMA 专用 Domain。' }
      this.logs.add('probe', 'Endpoint ownership: external-conflict；已有 Endpoint MCP 验证失败，请选择 PROMA 专用 Domain。', 'error')
      this.changed()
    }
  }
  async start(): Promise<McpTransportStatus> {
    await this.stop()
    const epoch = ++this.epoch; const abort = new AbortController(); this.abort = abort
    const current = () => epoch === this.epoch && !abort.signal.aborted
    this.state = { kind: this.kind, phase: 'preflight', ngrok: this.runtime() }; this.changed()
    try {
      const mode = ngrokMode(this.settings)
      const local = this.ingress.getLocalUrl(); if (!local) throw new Error('NGROK_LOCAL_INGRESS_UNAVAILABLE')
      const setOrigin = (origin: string) => {
        this.origin = origin; this.ingress.setPublicOrigin(origin)
        this.state.endpoint = { localUrl: local, publicUrl: origin, connectorUrl: origin + '/mcp/••••••••' }; this.changed()
      }
      if (mode === 'external-existing' || this.settings.endpointMode !== 'auto-domain') {
        if (!this.settings.hostname) throw new Error('NGROK_DOMAIN_REQUIRED')
        try { setOrigin(publicOrigin(this.settings.hostname)) } catch { throw new Error('NGROK_DOMAIN_INVALID') }
      }
      this.logs.add('system', `ngrok mode: ${mode}; credential: ${this.runtime().credentialSource}; endpoint: ${this.origin ?? '自动分配'}`)
      if (this.origin) {
        this.logs.add('probe', '正在验证已有 Endpoint 是否连接当前 PROMA。')
        try { const probe = await this.checkEndpoint(abort.signal); if (!current()) return this.getStatus(); this.ready(probe, true); return this.getStatus() }
        catch { if (!current()) return this.getStatus(); this.logs.add('probe', '已有 Endpoint 未通过当前 PROMA 完整 MCP 验证。', 'warn') }
      }
      if (mode === 'external-existing') throw new Error('NGROK_MCP_PROBE_FAILED')
      if (mode === 'proma-managed') {
        if (!this.token()) throw new Error('NGROK_AUTH_MISSING')
        if (this.settings.endpointMode !== 'auto-domain' && !this.settings.domainConfirmed) throw new Error('NGROK_DOMAIN_CONFIRMATION_REQUIRED')
        this.deps.prepareProfile()
      }
      const checked = await this.preflight()
      if (!current()) return this.getStatus()
      this.state = { ...this.state, ...checked, phase: 'starting' }
      if (!checked.ngrok?.config?.valid) throw new Error('NGROK_CONFIG_INVALID')
      this.logs.add('system', `config: ${checked.ngrok.config.source}; ${checked.ngrok.config.path ?? '系统默认'}；云端认证将在启动后验证。`)
      const args = ['http', local, ...(this.origin ? ['--url', this.origin] : []), ...this.configArgs(), '--log', 'stdout', '--log-format', 'json', ...(this.settings.webInspector === 'disabled' ? ['--inspect=false'] : [])]
      this.logs.add('command', [this.executable(), ...args].join(' '))
      const child = this.deps.spawn(this.executable(), args, { env: this.env(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child; this.state.pid = child.pid
      this.state.ngrok = { ...checked.ngrok!, ownership: 'proma-process' }
      let exited = false
      const observe = (line: string) => {
        if (!current() || this.child !== child) return
        if (/ERR_NGROK_/.test(line)) { this.state.errorCode = ngrokErrorCode(new Error(line)); this.state.errorMessage = redactProviderText(line, [this.secret(), mode === 'proma-managed' ? this.token() ?? '' : '']).slice(-1000) }
        const inspectorUrl = ngrokInspector(line)
        if (inspectorUrl) { this.state.ngrok = { ...this.state.ngrok!, inspectorUrl }; this.changed() }
        if (!this.origin && this.settings.endpointMode === 'auto-domain') {
          try { const event = JSON.parse(line) as { url?: string; msg?: string }; if (event.msg === 'started tunnel' && event.url?.startsWith('https://')) setOrigin(publicOrigin(event.url)) }
          catch { /* 非 JSON 输出仍进入安全日志。 */ }
        }
      }
      this.logs.attach(child.stdout, 'stdout', observe); this.logs.attach(child.stderr, 'stderr', observe)
      const onExit = () => {
        if (!current() || this.child !== child) return
        const wasReady = ['ready', 'degraded'].includes(this.state.phase)
        exited = true
        this.state = { ...this.state, pid: undefined, phase: 'error', ngrok: { ...this.state.ngrok!, ownership: 'none' }, errorCode: this.state.errorCode ?? 'NGROK_PROCESS_EXITED' }
        this.logs.add('system', 'ngrok 进程退出，保留此前日志。', 'error'); this.changed()
        // 公网探测可能先于 334 日志完成；晚到的冲突同样需要验证所有权。
        if (wasReady && this.state.errorCode === 'NGROK_ENDPOINT_CONFLICT') void this.recoverConflict(epoch, abort.signal)
      }
      child.once('close', onExit); child.once('error', onExit)
      const deadline = Date.now() + this.deps.timeoutMs
      while (current() && Date.now() < deadline) {
        if (exited || this.state.errorCode === 'NGROK_ENDPOINT_CONFLICT') break
        if (this.origin) {
          try {
            const probe = await this.checkEndpoint(abort.signal)
            if (!current()) return this.getStatus()
            if (exited || this.state.errorCode === 'NGROK_ENDPOINT_CONFLICT') break
            this.ready(probe, false); return this.getStatus()
          } catch { /* 等待启动，不停止其它进程。 */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!current()) return this.getStatus()
      if (this.state.errorCode === 'NGROK_ENDPOINT_CONFLICT') {
        // 334 可能来自两个启动者的竞态；再次完整验证后才允许复用。
        await this.recoverConflict(epoch, abort.signal)
        return this.getStatus()
      }
      if (!exited) { this.state.phase = 'degraded'; this.state.errorCode ??= 'NGROK_MCP_PROBE_FAILED'; this.logs.add('probe', '公网检查未通过。检查账号、独立域名及日志，连接进程保留。', 'warn'); this.changed() }
    } catch (error) {
      if (current()) {
        this.logs.add('system', error instanceof Error ? error.message : '启动失败', 'error')
        this.state = { ...this.state, phase: 'error', errorCode: ngrokErrorCode(error), errorMessage: this.logs.snapshot().at(-1)?.text }; this.changed()
      }
    }
    return this.getStatus()
  }
  async stop(): Promise<void> {
    this.epoch++; this.abort?.abort(); this.abort = undefined
    const child = this.child; this.child = undefined; await stopProviderProcess(child); this.origin = undefined
    this.state = { kind: this.kind, phase: 'stopped', ngrok: this.runtime() }; this.changed()
  }
  async diagnose(): Promise<McpTransportDiagnostic> {
    const epoch = this.epoch
    let checked: McpTransportStatus | undefined
    try { checked = await this.preflight() } catch { /* 诊断保留进程、配置与凭据。 */ }
    let probe: McpTransportStatus['probe']
    if (this.origin) {
      try { probe = await this.checkEndpoint(this.abort?.signal ?? AbortSignal.timeout(12000)) } catch { /* 下方展示失败与下一步。 */ }
      if (epoch === this.epoch && ['ready', 'degraded'].includes(this.state.phase)) {
        this.state = { ...this.state, probe, phase: probe ? 'ready' : 'degraded', errorCode: probe ? undefined : 'NGROK_PUBLIC_UNREACHABLE' }; this.changed()
      }
    }
    const state = this.getStatus(); const config = checked?.ngrok?.config
    return { status: state, checks: [
      { name: 'ngrok Binary', ok: checked?.binary?.ok === true || ngrokMode(this.settings) === 'external-existing', detail: checked?.binary?.detail ?? '外部管理或程序未验证', nextAction: '检测或安装官方 ngrok 程序' },
      { name: 'ngrok Config', ok: config?.valid === true || ngrokMode(this.settings) === 'external-existing', detail: config ? `${config.source}: ${config.path ?? '系统默认'}` : '外部管理或配置未验证', nextAction: '在连接设置检查所选配置' },
      { name: 'ngrok Credential', ok: config?.authConfigured === true || probe !== undefined, detail: state.ngrok?.credentialSource + (config?.authConfigured ? ' 已保存' : '；云端认证以启动结果为准'), nextAction: 'Managed 模式保存专用 Credential；系统模式检查 ngrok 认证' },
      { name: 'Endpoint Ownership', ok: ['proma-process', 'existing-proma-endpoint'].includes(state.ngrok?.ownership ?? ''), detail: state.ngrok?.ownership ?? 'none', nextAction: '为 PROMA 配置独占 Domain，或验证已有 PROMA Endpoint' },
      { name: 'ngrok 公网 MCP', ok: Boolean(probe), detail: probe ? `Modern MCP / tools ${probe.toolCount} / workspace_list 通过` : '公网完整验证未通过', nextAction: '检查公网地址、共享读取权限和 Provider 日志' },
    ] }
  }
}
