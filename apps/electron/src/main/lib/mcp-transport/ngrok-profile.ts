import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteProviderSettings, NgrokConfigDetection } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { writeTextFileAtomic } from '../safe-file'

export function ngrokMode(settings: RemoteProviderSettings): NonNullable<RemoteProviderSettings['mode']> {
  return settings.mode ?? (settings.authSource === 'system-config' ? 'system' : 'proma-managed')
}

export function ngrokProfilePath(base = getConfigDir()): string { return join(base, 'mcp-ngrok', 'ngrok.yml') }

/** 只生成无凭据的 PROMA 配置，绝不调用 config add-authtoken 或读取系统 Token。 */
export function prepareNgrokProfile(base = getConfigDir()): string {
  const path = ngrokProfilePath(base)
  mkdirSync(join(base, 'mcp-ngrok'), { recursive: true })
  writeTextFileAtomic(path, 'version: 3\nagent:\n  web_addr: 127.0.0.1:0\n  console_ui: false\n  update_check: false\n')
  return path
}

export function ngrokConfig(settings: RemoteProviderSettings, managedPath = ngrokProfilePath()): NgrokConfigDetection {
  const managed = ngrokMode(settings) === 'proma-managed'
  const path = managed ? managedPath : settings.configSource === 'custom' ? settings.configPath : undefined
  return { source: managed ? 'proma-managed' : settings.configSource === 'custom' ? 'custom' : 'system', path,
    valid: path ? existsSync(path) : settings.configSource !== 'custom' }
}

export function ngrokEnvironment(settings: RemoteProviderSettings, token?: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^NGROK_/i.test(name) || /^(https?|all)_proxy$/i.test(name) || /^(CONTROL_PLANE_API_KEY|PROMA_MCP_AUTH_HEADER|TUNNEL_TOKEN|TUNNEL_TOKEN_FILE|CONTROL_PLANE_HTTP_PROXY)$/i.test(name)) delete env[name]
  }
  if (ngrokMode(settings) === 'proma-managed' && token) env.NGROK_AUTHTOKEN = token
  return env
}
