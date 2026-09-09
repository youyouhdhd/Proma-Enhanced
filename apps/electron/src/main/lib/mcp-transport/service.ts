import { clipboard, safeStorage } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { McpTransportStatus, McpTransportKind, PromaRemoteAccessConfig, McpTransportDiagnostic } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { writeJsonFileAtomic } from '../safe-file'
import { promaMcpServerService } from '../mcp-server/service'
import { mcpTunnelService } from '../mcp-server/tunnel-service'
import { isConnectorRpc, rpcSucceeded } from '../mcp-server/protocol/protocol-negotiation'
import { normalizeRemoteConfig, readRemoteAccessConfig } from './config'
import { TransportSecretStore } from './secret-store'
import { PublicMcpIngress } from './public-ingress'
import { CloudflareProvider } from './cloudflare-provider'
import type { McpTransportProvider } from './types'

/** 保留现有 Local/OpenAI 服务，适配到统一生命周期，不注册工具。 */
class ExistingProvider implements McpTransportProvider {
  constructor(readonly kind: 'local' | 'openai-secure') {}
  async preflight() { return this.getStatus() }
  getStatus(): McpTransportStatus {
    const local = promaMcpServerService.getStatus()
    if (this.kind === 'local') return { kind: this.kind, phase: local.running ? 'ready' : 'stopped', ...(local.endpoint ? { endpoint: { localUrl: local.endpoint } } : {}) }
    const tunnel = mcpTunnelService.getState()
    const recent = local.recentRequests.filter((t) => t.at >= Date.now() - 5 * 60_000 && isConnectorRpc(t))
    const stalled = this.kind === 'openai-secure' && recent.some((t) => t.jsonRpcMethod === 'server/discover' && t.at <= Date.now() - 5000 && rpcSucceeded(t) && t.discoverValidated)
      && !recent.some((t) => t.jsonRpcMethod === 'tools/list')
    return { kind: this.kind, experimental: true,
      phase: tunnel.phase === 'connected' ? 'ready' : tunnel.phase === 'error' ? 'error' : ['preflight', 'starting', 'waiting-ready'].includes(tunnel.phase) ? 'starting' : 'stopped',
      ...(local.endpoint ? { endpoint: { localUrl: local.endpoint } } : {}),
      ...(this.kind === 'openai-secure' && tunnel.error ? { errorCode: tunnel.error.code, errorMessage: tunnel.error.title } : {}),
      ...(stalled && !tunnel.error ? { errorCode: 'UPSTREAM_HOSTED_DISCOVERY_STALLED', errorMessage: 'Discovery 已成功但未继续 tools/list；建议切换 Public HTTPS Transport。' } : {}),
    }
  }
  async start() {
    if (!promaMcpServerService.getStatus().running) await promaMcpServerService.startFromSettings()
    if (this.kind === 'openai-secure') await mcpTunnelService.start()
    return this.getStatus()
  }
  async stop() { if (this.kind === 'openai-secure') await mcpTunnelService.stop(); else await promaMcpServerService.stop() }
  async diagnose(): Promise<McpTransportDiagnostic> {
    if (this.kind === 'openai-secure') {
      const diagnosis = await mcpTunnelService.diagnoseConnector(Date.now() - 5 * 60_000)
      const status = this.getStatus()
      if (diagnosis.protocolNegotiation?.discoverRpcOk && !diagnosis.protocolNegotiation.toolsListSeen) {
        status.errorCode = 'UPSTREAM_HOSTED_DISCOVERY_STALLED'
        status.errorMessage = 'Discovery 已成功，但未收到 tools/list。建议切换 Public HTTPS，不继续修改 MCP 协议。'
      }
      return { status, checks: diagnosis.checks.map((c) => ({ name: c.name, ok: c.state === 'pass', detail: c.message ?? c.state })) }
    }
    const status = this.getStatus()
    return { status, checks: [{ name: 'Local MCP', ok: status.phase === 'ready', detail: status.endpoint?.localUrl ?? '未运行' }] }
  }
}

class McpTransportService {
  private provider?: McpTransportProvider
  private generation = 0
  private secrets(): TransportSecretStore {
    return new TransportSecretStore(getConfigDir(), {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      encryptString: (value) => safeStorage.encryptString(value), decryptString: (value) => safeStorage.decryptString(value),
    })
  }
  getConfig(): PromaRemoteAccessConfig {
    return readRemoteAccessConfig()
  }
  save(value: unknown): PromaRemoteAccessConfig {
    if (['preflight', 'starting', 'ready'].includes(this.getStatus().phase)) throw new Error('请先停止远程连接再修改配置')
    const config = normalizeRemoteConfig(value)
    mkdirSync(getConfigDir(), { recursive: true })
    writeJsonFileAtomic(join(getConfigDir(), 'mcp-remote-access.json'), config)
    this.provider = undefined
    return config
  }
  getStatus(): McpTransportStatus {
    const kind = this.getConfig().mode
    const status = this.provider?.getStatus() ?? (kind === 'local' || kind === 'openai-secure' ? new ExistingProvider(kind).getStatus() : { kind, phase: 'stopped' as const })
    if (!status.kind.startsWith('cloudflare')) return status
    try { return { ...status, ...(status.kind === 'cloudflare-named' ? { tokenConfigured: Boolean(this.secrets().read('cloudflare')) } : {}), secretConfigured: Boolean(this.secrets().read('connector')) } }
    catch { return { ...status, errorCode: 'TRANSPORT_SECRET_UNREADABLE', errorMessage: '系统凭据无法解密，请重新保存；Connector Secret 不会被静默替换。' } }
  }
  private create(kind: McpTransportKind, config: PromaRemoteAccessConfig): McpTransportProvider {
    if (kind === 'local' || kind === 'openai-secure') return new ExistingProvider(kind)
    if (!config.publicIngress.workspaceIds.length || !promaMcpServerService.hasPublicWorkspace(config.publicIngress.workspaceIds)) throw new Error('PUBLIC_WORKSPACE_SCOPE_EMPTY')
    const store = this.secrets(); store.ensureConnector()
    const marker = randomBytes(24).toString('hex')
    const ingress = new PublicMcpIngress(promaMcpServerService.publicTools(config.publicIngress.workspaceIds), () => store.read('connector') ?? '', marker)
    return new CloudflareProvider(kind, config, ingress, () => store.read('connector') ?? '', () => store.read('cloudflare'), marker)
  }
  async start(): Promise<McpTransportStatus> {
    const generation = ++this.generation
    const previous = this.provider; this.provider = undefined
    await previous?.stop()
    if (generation !== this.generation) return this.getStatus()
    const config = this.getConfig()
    const provider = this.create(config.mode, config)
    this.provider = provider
    await provider.start()
    if (generation !== this.generation) await provider.stop()
    return this.getStatus()
  }
  async stop(): Promise<McpTransportStatus> {
    this.generation++
    const kind = this.getConfig().mode
    if (this.provider) await this.provider.stop()
    else if (kind === 'local' || kind === 'openai-secure') await new ExistingProvider(kind).stop()
    return this.getStatus()
  }
  async diagnose(): Promise<McpTransportDiagnostic> {
    if (!this.provider) return { status: this.getStatus(), checks: [{ name: 'Transport', ok: false, detail: '请先启动连接' }] }
    return this.provider.diagnose()
  }
  saveToken(value: unknown): void {
    if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw new Error('CLOUDFLARE_TUNNEL_TOKEN_INVALID')
    this.secrets().save('cloudflare', value)
  }
  async rotateSecret(): Promise<void> { await this.stop(); this.secrets().rotateConnector() }
  copyConnectorUrl(): void {
    const status = this.getStatus()
    if (status.phase !== 'ready' || !status.kind.startsWith('cloudflare') || !status.endpoint?.publicUrl) throw new Error('Public MCP 尚未就绪')
    const secret = this.secrets().read('connector')
    if (!secret) throw new Error('PUBLIC_CONNECTOR_SECRET_MISSING')
    clipboard.writeText(status.endpoint.publicUrl + '/mcp/' + secret)
  }
}
export const mcpTransportService = new McpTransportService()
