import { clipboard, safeStorage } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import type { McpTransportStatus, McpTransportKind, PromaRemoteAccessConfig, McpTransportDiagnostic, McpSharingConfig } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { writeJsonFileAtomic, readJsonFileSafe } from '../safe-file'
import { promaMcpServerService } from '../mcp-server/service'
import { mcpTunnelService } from '../mcp-server/tunnel-service'
import { normalizeRemoteConfig, readRemoteAccessConfig, remoteApplyImpact } from './config'
import { TransportSecretStore } from './secret-store'
import { PublicMcpIngress } from './public-ingress'
import { CloudflareProvider } from './cloudflare-provider'
import { NetworkProvider, runProviderCommand } from './network-provider'
import { NgrokProvider } from './ngrok-provider'
import { REMOTE_PROVIDERS } from './provider-registry'
import type { McpTransportProvider } from './types'
import { mcpSharingStore } from '../mcp-sharing/store'
import { createPrimitiveCatalog, withDelegation, toolFingerprint } from '../mcp-sharing/catalog'
import { createDelegationQueue, validateDelegationTargets } from '../mcp-sharing/delegation'
import type { McpToolHandlers } from '../mcp-server/protocol/modern-server'
import { normalizeSharing } from '../mcp-sharing/config'
import { RemoteExecutionGuard } from '../mcp-sharing/tool-policy'

class OpenAiSecureProvider implements McpTransportProvider {
  readonly kind = 'openai-secure' as const
  constructor(private readonly ingress: PublicMcpIngress, private readonly secret: () => string) {}
  async preflight() { await mcpTunnelService.detectClient(); return this.getStatus() }
  clearLogs(): void { mcpTunnelService.clearProviderLogs() }
  getStatus(): McpTransportStatus {
    const state = mcpTunnelService.getState()
    const requests = this.ingress.getRequests()
    const stalled = requests.some((t) => t.rpcMethod === 'server/discover' && t.status === 200 && t.at < Date.now() - 5000) && !requests.some((t) => t.rpcMethod === 'tools/list')
    return { kind: this.kind, experimental: true, phase: state.phase === 'connected' ? 'ready' : state.phase === 'error' ? 'error' : ['starting','waiting-ready','preflight'].includes(state.phase) ? 'starting' : 'stopped',
      endpoint: { localUrl: this.ingress.getLocalUrl() ?? '' }, requests, logs: mcpTunnelService.getProviderLogs(), pid: state.pid,
      ...(state.error ? { errorCode: state.error.code, errorMessage: state.error.title } : stalled ? { errorCode: 'UPSTREAM_HOSTED_DISCOVERY_STALLED', errorMessage: 'Discovery 后未继续 tools/list，建议切换 Public HTTPS。' } : {}) }
  }
  async start() {
    const endpoint = this.ingress.getLocalUrl()
    if (!endpoint) throw new Error('REMOTE_INGRESS_NOT_RUNNING')
    mcpTunnelService.setRemoteTarget({ endpoint: endpoint + '/mcp', token: this.secret() })
    await mcpTunnelService.start(); return this.getStatus()
  }
  async stop() { await mcpTunnelService.stop(); mcpTunnelService.setRemoteTarget(undefined) }
  async diagnose(): Promise<McpTransportDiagnostic> { const status = this.getStatus(); return { status, checks: [{ name: 'OpenAI Secure Runtime', ok: status.phase === 'ready', detail: status.errorCode ?? status.phase }] } }
}

class McpTransportService {
  private provider?: McpTransportProvider
  private generation = 0
  private ingress?: PublicMcpIngress
  private runtime?: PromaRemoteAccessConfig
  private marker = randomBytes(24).toString('hex')
  private restartRequired = false
  private impact: McpTransportStatus['applyImpact'] = 'none'
  private previousIdentity?: string
  private urlChanged = false
  private readonly listeners = new Set<(kind: 'config' | 'status' | 'sharing') => void>()
  private readonly executionGuard = new RemoteExecutionGuard()
  private readonly queue = createDelegationQueue((id) => this.primitive(() => [id], true), (id) => this.scope().includes(id), () => this.emit('sharing'))
  private readonly catalog = withDelegation(this.primitive(() => this.scope()), () => {
    const sharing = mcpSharingStore.get(); return sharing.enabled && sharing.delegation.enabled
  }, this.queue)
  constructor() {
    mcpSharingStore.onChanged(() => { this.queue.reconcile(); this.executionGuard.reconcile(mcpSharingStore.entries(this.scope()), mcpSharingStore.get()); void promaMcpServerService.syncSharing().catch(() => undefined); this.impact = 'hot'; this.emit('sharing'); this.emit('status') })
    mcpTunnelService.onStateChanged(() => { if (this.runtime?.provider === 'openai-secure') this.emit('status') })
  }
  onChanged(listener: (kind: 'config' | 'status' | 'sharing') => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(kind: 'config' | 'status' | 'sharing') { for (const listener of this.listeners) listener(kind) }
  private secrets(): TransportSecretStore {
    return new TransportSecretStore(getConfigDir(), { isEncryptionAvailable: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'), encryptString: (s) => safeStorage.encryptString(s), decryptString: (s) => safeStorage.decryptString(s) })
  }
  getConfig(): PromaRemoteAccessConfig { return readRemoteAccessConfig() }
  private scope(): string[] {
    const remote = this.getConfig(); const sharing = mcpSharingStore.get()
    return sharing.roots.filter((r) => r.enabled && (remote.publicIngress.scopeMode === 'inherit' || remote.publicIngress.workspaceIds.includes(r.id))).map((r) => r.id)
  }
  private primitive(scope: () => string[], forAgent = false): McpToolHandlers {
    return createPrimitiveCatalog(() => { const config = mcpSharingStore.get(); return forAgent ? { ...config, policy: { read: 'direct', write: 'disabled', execute: 'disabled' } } : config }, () => mcpSharingStore.entries(scope()), (id) => {
      const entry = mcpSharingStore.entries(scope()).find((e) => e.id === id && e.enabled)
      return entry ? { entry, context: { workspaceId: id, rootPath: entry.rootPath } } : { error: '共享目录不可用或权限已撤销' }
    }, true, this.executionGuard)
  }
  async saveSharing(value: unknown): Promise<McpSharingConfig> {
    const next = normalizeSharing(value)
    if (next.delegation.enabled && !(await validateDelegationTargets(next.delegation.targets)).some((item) => item.ready)) throw new Error('至少选择一个已授权可用的 Agent 模型')
    const old = mcpSharingStore.get()
    const saved = mcpSharingStore.save(next)
    if (!next.delegation.enabled) this.queue.cancelAll()
    return saved
  }
  async save(value: unknown): Promise<PromaRemoteAccessConfig> {
    const config = normalizeRemoteConfig(value)
    this.impact = remoteApplyImpact(this.getConfig(), config)
    mkdirSync(getConfigDir(), { recursive: true }); writeJsonFileAtomic(join(getConfigDir(), 'mcp-remote-access.json'), config)
    this.restartRequired = Boolean(this.provider && !['none','hot'].includes(this.impact!))
    this.queue.reconcile(); this.executionGuard.reconcile(mcpSharingStore.entries(this.scope()), mcpSharingStore.get()); this.emit('config'); this.emit('status')
    if (!config.enabled) await this.stop()
    return config
  }
  getStatus(): McpTransportStatus {
    const config = this.getConfig()
    const status: McpTransportStatus = this.provider?.getStatus() ?? { kind: config.provider, phase: 'stopped' }
    const origin = status.endpoint?.publicUrl
    let identity: string | undefined
    try {
      if (origin && status.phase === 'ready') {
        const secret = this.secrets().read('connector')
        if (secret) {
          identity = createHash('sha256').update(origin + '/mcp/' + secret).digest('hex')
          if (!this.previousIdentity) this.previousIdentity = readJsonFileSafe<{ fingerprint: string }>(join(getConfigDir(), 'mcp-connector-identity.json'))?.fingerprint
          if (this.previousIdentity && this.previousIdentity !== identity) this.urlChanged = true
          if (this.previousIdentity !== identity) writeJsonFileAtomic(join(getConfigDir(), 'mcp-connector-identity.json'), { publicOrigin: origin, fingerprint: identity })
          this.previousIdentity = identity
        }
      }
      return { ...status, requests: this.ingress?.getRequests() ?? [], restartRequired: this.restartRequired, applyImpact: this.impact,
        toolSchemaFingerprint: toolFingerprint(this.catalog), confirmedToolSchemaFingerprint: readJsonFileSafe<{ fingerprint: string }>(join(getConfigDir(), 'mcp-tool-schema-ack.json'))?.fingerprint, connectorUrlFingerprint: identity ?? this.previousIdentity, urlChanged: this.urlChanged,
        stableUrl: status.stableUrl ?? REMOTE_PROVIDERS.find((p) => p.kind === (this.runtime?.provider ?? config.provider))?.capabilities.stableUrl,
        secretConfigured: Boolean(this.secrets().read('connector')), tokenConfigured: config.provider === 'ngrok' ? Boolean(this.secrets().read('ngrok')) : config.provider === 'cloudflare-named' ? Boolean(this.secrets().read('cloudflare')) : config.provider === 'openai-secure' ? mcpTunnelService.getRuntimeKeyStatus() === 'available' : undefined }
    } catch { return { ...status, restartRequired: this.restartRequired, errorCode: 'TRANSPORT_SECRET_UNREADABLE', errorMessage: '凭据无法解密，请重新保存；不会静默更换 Secret。' } }
  }
  async start(): Promise<McpTransportStatus> {
    const generation = ++this.generation
    const old = this.provider; this.provider = undefined; await old?.stop()
    const config = this.getConfig()
    if (!config.enabled || !config.provider) throw new Error('REMOTE_DISABLED')
    if (!mcpSharingStore.get().enabled || !this.catalog.list().length) throw new Error('请先开启共享及至少一种工具能力')
    if (generation !== this.generation) return this.getStatus()
    const store = this.secrets(); store.ensureConnector()
    if (this.ingress && this.runtime?.publicIngress.port !== config.publicIngress.port) { await this.ingress.stop(); this.ingress = undefined }
    this.ingress ??= new PublicMcpIngress(this.catalog, () => store.read('connector') ?? '', this.marker)
    if (!this.ingress.getLocalUrl()) await this.ingress.start(config.publicIngress.port)
    if (generation !== this.generation) return this.getStatus()
    this.runtime = config; this.restartRequired = false
    const changed = () => this.emit('status')
    this.provider = config.provider.startsWith('cloudflare')
      ? new CloudflareProvider(config.provider as 'cloudflare-quick' | 'cloudflare-named', config, this.ingress, () => store.read('connector') ?? '', () => store.read('cloudflare'), this.marker, { changed })
      : config.provider === 'openai-secure' ? new OpenAiSecureProvider(this.ingress, () => store.read('connector') ?? '')
        : config.provider === 'ngrok' ? new NgrokProvider(config.providers.ngrok ?? {}, this.ingress, () => store.read('connector') ?? '', () => store.read('ngrok'), this.marker, changed)
        : new NetworkProvider(config.provider as 'tailscale-funnel' | 'external-https', config.providers[config.provider] ?? {}, this.ingress, () => store.read('connector') ?? '', () => undefined, this.marker, changed)
    const provider = this.provider
    this.emit('status'); await provider.start()
    if (generation !== this.generation) await provider.stop()
    this.emit('status'); return this.getStatus()
  }
  async stop(): Promise<McpTransportStatus> {
    this.generation++; this.queue.cancelAll(); this.executionGuard.revoke(); await this.provider?.stop(); await this.ingress?.stop(); this.ingress = undefined
    this.emit('status'); return this.getStatus()
  }
  async diagnose(): Promise<McpTransportDiagnostic> {
    const health = mcpSharingStore.health()
    const checks = [
      { name: 'Shared Roots', ok: health.length > 0 && health.every((root) => root.state === 'available'), detail: health.length ? health.map((root) => `${root.id}: ${root.state}`).join('；') : '请先添加共享项目' },
      { name: 'Tool Catalog', ok: this.catalog.list().length > 0, detail: `${this.catalog.list().length} 个工具；检查全局策略和工具开关` },
      { name: 'Remote Ingress', ok: Boolean(this.ingress?.getLocalUrl()), detail: this.ingress?.getLocalUrl() ?? '尚未启动，请启动远程连接' },
    ]
    const detected = await this.detect()
    checks.push({ name: 'Provider Binary / Config', ok: detected.ok, detail: detected.detail })
    const result = this.provider ? await this.provider.diagnose() : undefined
    const status = this.getStatus()
    checks.push({ name: 'Provider Process / Connection', ok: ['ready', 'degraded'].includes(status.phase), detail: `状态 ${status.phase}，PID ${status.pid ?? '外部管理或未运行'}` })
    if (result) checks.push(...result.checks)
    checks.push({ name: 'MCP Discovery / tools/list', ok: status.probe?.modern === true, detail: status.probe ? `${status.probe.toolCount} 个工具` : '未完成公网 MCP 探测，请查看 Provider 日志' },
      { name: 'workspace_list', ok: status.probe?.workspaceList === true, detail: status.probe?.workspaceList ? '已通过' : '未验证或读取工具未开放' })
    return { status, checks }
  }
  async detect(): Promise<{ ok: boolean; detail: string }> {
    const config = this.getConfig(); const kind = config.provider
    if (!kind || kind === 'external-https') return { ok: true, detail: '不需要本地程序' }
    if (kind === 'openai-secure') { const found = await mcpTunnelService.detectClient(); return { ok: found.installed && found.executableKind === 'full-cli', detail: found.version ?? found.errorMessage ?? '未检测到 full CLI' } }
    try {
      const executable = config.providers[kind]?.executablePath ?? (kind.startsWith('cloudflare') ? 'cloudflared' : kind === 'ngrok' ? 'ngrok' : 'tailscale')
      const output = await runProviderCommand(executable, [kind.startsWith('cloudflare') ? '--version' : 'version'])
      if (kind === 'ngrok') {
        const settings = config.providers.ngrok ?? {}
        const env = { ...process.env }; delete env.NGROK_AUTHTOKEN
        if (settings.authSource === 'proma-secret') {
          const token = this.secrets().read('ngrok'); if (!token) return { ok: false, detail: 'NGROK_AUTH_MISSING：请保存 ngrok Authtoken' }
          env.NGROK_AUTHTOKEN = token
        }
        await runProviderCommand(executable, ['config', 'check', ...(settings.configSource === 'custom' && settings.configPath ? ['--config', settings.configPath] : [])], env)
        return { ok: true, detail: output.trim().split('\n')[0] + '；配置有效，云端认证将在启动后验证。' }
      }
      if (kind === 'tailscale-funnel') { const state = JSON.parse(await runProviderCommand(executable, ['status','--json'])); if (state.BackendState !== 'Running') return { ok: false, detail: '设备尚未登录 Tailscale' } }
      return { ok: true, detail: output.trim().split('\n')[0]!.slice(0, 120) }
    } catch { return { ok: false, detail: '未找到程序或程序无法运行，请选择官方程序后重试' } }
  }
  saveToken(value: unknown, requestedProvider?: McpTransportKind): void {
    if (typeof value !== 'string' || !value.trim() || value.length > 8192 || value.includes('\0')) throw new Error('TOKEN_INVALID')
    const provider = requestedProvider ?? this.getConfig().provider
    if (provider === 'openai-secure') mcpTunnelService.saveRuntimeKey(value)
    else if (provider === 'ngrok') this.secrets().save('ngrok', value)
    else if (provider === 'cloudflare-named') this.secrets().save('cloudflare', value)
    else throw new Error('当前连接方式不需要 Token')
    this.restartRequired = Boolean(this.provider && this.runtime?.provider === provider); this.impact = 'provider-restart'; this.emit('status')
  }
  async rotateSecret(): Promise<void> { await this.stop(); this.secrets().rotateConnector(); this.urlChanged = true; this.impact = 'connector-url-changed'; this.emit('status') }
  copyConnectorUrl(): void {
    const status = this.getStatus()
    if (!['ready','degraded'].includes(status.phase) || !status.endpoint?.publicUrl) throw new Error('尚无公网 URL')
    const secret = this.secrets().read('connector'); if (!secret) throw new Error('PUBLIC_CONNECTOR_SECRET_MISSING')
    clipboard.writeText(status.endpoint.publicUrl + '/mcp/' + secret); this.urlChanged = false; this.emit('status')
  }
  tasks() { return this.queue.snapshot() }
  async validateTargets(value: unknown) {
    const config = normalizeSharing(value)
    return (await validateDelegationTargets(config.delegation.targets)).map(({ target, ready, detail }) => ({ id: target.id, ready, detail }))
  }
  clearLogs(): void { this.provider?.clearLogs?.(); this.emit('status') }
  cancelTask(id: string) { this.queue.cancel(id) }
  confirmToolSchema(): void { writeJsonFileAtomic(join(getConfigDir(), 'mcp-tool-schema-ack.json'), { fingerprint: toolFingerprint(this.catalog) }); this.emit('status') }
}
export const mcpTransportService = new McpTransportService()
