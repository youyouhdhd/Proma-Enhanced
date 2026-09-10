import type { PromaRemoteAccessConfig, McpRemoteProviderKind, RemoteProviderSettings, ApplyImpact } from '@proma/shared'
import { join, isAbsolute } from 'node:path'
import { isIP } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { getConfigDir } from '../config-paths'
import { writeJsonFileAtomic } from '../safe-file'
import { getSettings } from '../settings-service'

export const REMOTE_KINDS: McpRemoteProviderKind[] = ['cloudflare-quick', 'cloudflare-named', 'tailscale-funnel', 'ngrok', 'external-https', 'openai-secure']
export function publicOrigin(value: string): string {
  const url = new URL(value.includes('://') ? value : 'https://' + value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' || !url.hostname.includes('.') || isIP(url.hostname.replace(/^\[|\]$/g, '')) || /(^localhost\.|\.(local|localhost)$)/.test(url.hostname)) throw new Error('PUBLIC_HOSTNAME_INVALID')
  return url.origin
}
export function normalizeRemoteConfig(value: unknown, hasNgrokSecret = false): PromaRemoteAccessConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (raw.version !== 2 && raw.version !== 3) {
    const old = raw as { mode?: string; autoStart?: boolean; publicIngress?: { port?: number; workspaceIds?: string[] }; cloudflare?: { customPath?: string; hostname?: string }; openai?: { controlPlaneProxy?: string } }
    const kind = REMOTE_KINDS.includes(old.mode as McpRemoteProviderKind) ? old.mode as McpRemoteProviderKind : undefined
    return normalizeRemoteConfig({ version: 2, enabled: Boolean(kind), provider: kind, autoStart: old.autoStart === true,
      publicIngress: { port: old.publicIngress?.port ?? 8787, scopeMode: old.publicIngress?.workspaceIds ? 'custom' : 'inherit', workspaceIds: old.publicIngress?.workspaceIds ?? [] },
      providers: kind ? { [kind]: { executablePath: old.cloudflare?.customPath, hostname: old.cloudflare?.hostname, controlPlaneProxy: old.openai?.controlPlaneProxy } } : {} })
  }
  const source = raw as unknown as Partial<PromaRemoteAccessConfig>
  if (source.provider && !REMOTE_KINDS.includes(source.provider)) throw new Error('REMOTE_PROVIDER_INVALID')
  if (source.enabled === true && !source.provider) throw new Error('请选择远程连接方案')
  const port = source.publicIngress?.port ?? 8787
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PUBLIC_INGRESS_PORT_INVALID')
  const ids = source.publicIngress?.workspaceIds ?? []
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => typeof id !== 'string')) throw new Error('REMOTE_SCOPE_INVALID')
  const providers: PromaRemoteAccessConfig['providers'] = {}
  for (const kind of REMOTE_KINDS) {
    const item = source.providers?.[kind]
    if (!item) continue
    const normalized: RemoteProviderSettings = {}
    if (item.executablePath) {
      if (typeof item.executablePath !== 'string' || !isAbsolute(item.executablePath) || item.executablePath.includes('\0')) throw new Error('PROVIDER_PATH_INVALID')
      normalized.executablePath = item.executablePath
    }
    if (item.hostname) normalized.hostname = publicOrigin(item.hostname)
    if (kind === 'ngrok') {
      normalized.authSource = item.authSource === 'proma-secret' || raw.version === 2 && !item.authSource && hasNgrokSecret ? 'proma-secret' : 'system-config'
      if (item.mode !== undefined && !['proma-managed', 'system', 'external-existing'].includes(item.mode)) throw new Error('NGROK_MODE_INVALID')
      normalized.mode = item.mode ?? (normalized.authSource === 'proma-secret' ? 'proma-managed' : 'system')
      normalized.credentialMode = normalized.mode === 'proma-managed' ? 'proma-secret' : 'system-config'
      normalized.authSource = normalized.credentialMode
      normalized.domainConfirmed = item.domainConfirmed === true
      normalized.configSource = item.configSource === 'custom' ? 'custom' : 'default'
      normalized.endpointMode = item.endpointMode === 'auto-domain' ? 'auto-domain' : 'fixed-domain'
      normalized.webInspector = item.webInspector === 'disabled' ? 'disabled' : 'default'
      if (normalized.mode === 'proma-managed') normalized.configSource = 'default'
      if (item.configPath && normalized.mode === 'system') {
        if (typeof item.configPath !== 'string' || !isAbsolute(item.configPath) || item.configPath.includes('\0')) throw new Error('NGROK_CONFIG_INVALID')
        normalized.configPath = item.configPath
      }
    }
    if (kind === 'openai-secure') {
      if (typeof item.tunnelId === 'string') normalized.tunnelId = item.tunnelId.trim()
      if (item.controlPlaneProxy) { const url = new URL(item.controlPlaneProxy); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('CONTROL_PLANE_PROXY_INVALID'); normalized.controlPlaneProxy = item.controlPlaneProxy }
    }
    providers[kind] = normalized
  }
  return { version: 3, enabled: source.enabled === true, ...(source.provider ? { provider: source.provider } : {}), autoStart: source.autoStart === true,
    publicIngress: { port, scopeMode: source.publicIngress?.scopeMode === 'custom' ? 'custom' : 'inherit', workspaceIds: [...new Set(ids)] }, providers }
}
export function readRemoteAccessConfig(): PromaRemoteAccessConfig {
  const file = join(getConfigDir(), 'mcp-remote-access.json')
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const next = normalizeRemoteConfig(raw, existsSync(join(getConfigDir(), 'mcp-transport-ngrok')))
      if (raw.version !== 3) {
        const old = getSettings().mcpTunnel
        if (raw.version !== 2 && next.provider === 'openai-secure') next.providers['openai-secure'] = { ...next.providers['openai-secure'], tunnelId: old?.tunnelId, executablePath: old?.executablePath }
        writeJsonFileAtomic(file, next)
      }
      return next
    } catch { return normalizeRemoteConfig({ version: 2 }) }
  }
  const old = getSettings().mcpTunnel
  const config = normalizeRemoteConfig({ version: 2, enabled: Boolean(old?.tunnelId), provider: old?.tunnelId ? 'openai-secure' : undefined,
    autoStart: old?.autoConnect === true, providers: { 'openai-secure': { tunnelId: old?.tunnelId, executablePath: old?.executablePath } } })
  writeJsonFileAtomic(file, config)
  return config
}
export function remoteApplyImpact(old: PromaRemoteAccessConfig, next: PromaRemoteAccessConfig): ApplyImpact {
  if (old.publicIngress.port !== next.publicIngress.port) return 'ingress-restart'
  if (old.provider !== next.provider || old.enabled !== next.enabled) return 'provider-restart'
  if (JSON.stringify(old.providers) !== JSON.stringify(next.providers)) return old.provider && old.providers[old.provider]?.hostname !== next.providers[old.provider]?.hostname ? 'connector-url-changed' : 'provider-restart'
  if (JSON.stringify(old.publicIngress) !== JSON.stringify(next.publicIngress)) return 'hot'
  return 'none'
}
