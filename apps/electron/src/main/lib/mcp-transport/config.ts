import type { PromaRemoteAccessConfig } from '@proma/shared'
import { join, isAbsolute } from 'node:path'
import { isIP } from 'node:net'
import { getConfigDir } from '../config-paths'
import { existsSync, readFileSync } from 'node:fs'
import { getSettings } from '../settings-service'

export function readRemoteAccessConfig(): PromaRemoteAccessConfig {
  const file = join(getConfigDir(), 'mcp-remote-access.json')
  // 自动启动属于公网授权边界：损坏时不能从旧 .bak 自动恢复一个曾被关闭的公网模式。
  if (existsSync(file)) {
    try { return normalizeRemoteConfig(JSON.parse(readFileSync(file, 'utf8'))) }
    catch { return normalizeRemoteConfig(undefined) }
  }
  const settings = getSettings()
  // 只在尚无新配置时兼容旧连接偏好；损坏的新配置回退 Local，不重新开启旧远程通路。
  return normalizeRemoteConfig({ mode: settings.mcpTunnel?.tunnelId ? 'openai-secure' : 'local',
    autoStart: settings.mcpServer?.enabled === true && settings.mcpTunnel?.autoConnect === true })
}

export function publicOrigin(value: string): string {
  const url = new URL(value.includes('://') ? value : 'https://' + value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' || !url.hostname.includes('.') || isIP(url.hostname.replace(/^\[|\]$/g, '')) || /(^localhost\.|\.(local|localhost)$)/.test(url.hostname)) throw new Error('CLOUDFLARE_HOSTNAME_INVALID')
  return url.origin
}
export function normalizeRemoteConfig(value: unknown): PromaRemoteAccessConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<PromaRemoteAccessConfig>
  const mode = raw.mode ?? 'local'
  if (!['local', 'cloudflare-quick', 'cloudflare-named', 'openai-secure'].includes(mode)) throw new Error('TRANSPORT_KIND_INVALID')
  const port = raw.publicIngress?.port ?? 8787
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PUBLIC_INGRESS_PORT_INVALID')
  const ids = raw.publicIngress?.workspaceIds ?? []
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || ids.length > 500) throw new Error('PUBLIC_WORKSPACE_SCOPE_INVALID')
  const cf = raw.cloudflare
  if (cf?.customPath && (typeof cf.customPath !== 'string' || cf.customPath.includes('\0') || !isAbsolute(cf.customPath) || /^[a-z]+:\/\//i.test(cf.customPath))) throw new Error('CLOUDFLARED_PATH_INVALID')
  const proxy = raw.openai?.controlPlaneProxy
  if (proxy) { const parsed = new URL(proxy); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('CONTROL_PLANE_PROXY_INVALID') }
  return { mode, autoStart: raw.autoStart === true,
    publicIngress: { port, profile: 'public-readonly', workspaceIds: [...new Set(ids)] },
    cloudflare: { executableMode: cf?.executableMode === 'custom-path' ? 'custom-path' : 'system-path',
      ...(cf?.customPath ? { customPath: cf.customPath.trim() } : {}), ...(cf?.hostname ? { hostname: publicOrigin(cf.hostname) } : {}) },
    openai: { ...(proxy ? { controlPlaneProxy: proxy } : {}) },
  }
}
