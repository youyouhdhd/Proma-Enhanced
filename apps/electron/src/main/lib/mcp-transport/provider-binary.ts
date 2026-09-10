import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { McpRemoteProviderKind, ProviderBinaryDetection } from '@proma/shared'
import { REMOTE_PROVIDERS } from '@proma/shared'
import { runProviderCommand } from './provider-process-runner'
import { ngrokEnvironment } from './ngrok-profile'
import { openAiTunnelClientAdapter } from '../mcp-server/tunnel-client-adapter'

export async function detectProviderBinary(kind: McpRemoteProviderKind, customPath?: string,
  command = runProviderCommand): Promise<ProviderBinaryDetection> {
  const descriptor = REMOTE_PROVIDERS.find((provider) => provider.kind === kind)?.controls.binary
  if (!descriptor) return { ok: true, detail: '不需要本地程序' }
  if (customPath && (typeof customPath !== 'string' || !isAbsolute(customPath) || customPath.includes('\0'))) return { ok: false, detail: 'PROVIDER_PATH_INVALID' }
  const resolvedPath = customPath ?? (process.env.PATH ?? '').split(delimiter).flatMap((dir) =>
    (process.platform === 'win32' ? [descriptor.command + '.exe', descriptor.command] : [descriptor.command]).map((name) => join(dir.replace(/^"|"$/g, ''), name))).find(existsSync)
  const source = customPath ? 'custom' : 'path'
  try {
    const env = ngrokEnvironment({ mode: 'system' })
    const executable = resolvedPath ?? descriptor.command
    const output = await command(executable, [kind.startsWith('cloudflare') || kind === 'openai-secure' ? '--version' : 'version'], env)
    const pattern = kind === 'ngrok' ? /^ngrok(?: version)?\s+3\./im : kind.startsWith('cloudflare') ? /cloudflared.*\d+\./i : kind === 'tailscale-funnel' ? /(?:^|\s)\d+\.\d+\.\d+/ : /tunnel-client.*\d+\./i
    if (!pattern.test(output)) throw new Error('版本输出不匹配')
    if (kind === 'openai-secure') {
      await command(executable, openAiTunnelClientAdapter.buildDoctorHelpArgs(), env)
      await command(executable, openAiTunnelClientAdapter.buildRunHelpArgs(), env)
    }
    if (kind === 'tailscale-funnel' && !/tailscale/i.test(await command(executable, ['--help'], env))) throw new Error('程序身份不匹配')
    const version = output.trim().split('\n')[0]!.slice(0, 120)
    return { ok: true, source, resolvedPath, version, detail: `${descriptor.displayName} 已安装；来源：${customPath ? '自定义程序' : '系统 PATH'}` }
  } catch {
    return { ok: false, source, resolvedPath, detail: `${kind === 'ngrok' ? 'NGROK_BINARY_INVALID' : 'PROVIDER_BINARY_INVALID'}：未找到或无法验证 ${descriptor.displayName}，请安装官方程序后重新检测。` }
  }
}
