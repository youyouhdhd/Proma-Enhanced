/**
 * OpenAiTunnelClientAdapter — 官方 tunnel-client CLI 封装（规范 §17）
 *
 * 当前官方版本的使用方式：
 *   tunnel-client --version
 *   tunnel-client doctor --control-plane.tunnel-id <id> --mcp.server-url <url>
 *   tunnel-client run \
 *     --control-plane.tunnel-id <id> \
 *     --mcp.server-url <url> \
 *     --health.listen-addr <addr> \
 *     --health.url-file <file>
 *
 * Runtime API Key 一律经 CONTROL_PLANE_API_KEY 环境变量注入，绝不进 argv。
 * 若官方 CLI 参数变化，只需要更新本文件。
 */

import type { TunnelDoctorRaw, TunnelDoctorResult, TunnelRuntimeConfig } from './tunnel-client-types'

export interface TunnelClientAdapter {
  buildVersionArgs(): string[]
  buildDoctorArgs(input: TunnelRuntimeConfig): string[]
  buildRunArgs(input: TunnelRuntimeConfig): string[]
  parseVersion(output: string): string | undefined
  parseDoctor(raw: TunnelDoctorRaw, version?: string): TunnelDoctorResult
}

/** 从 --version 输出中解析语义化版本 */
export function parseVersionOutput(output: string): string | undefined {
  const match = /v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(output)
  return match ? 'v' + match[1]! : undefined
}

/** 常见失败关键词 → 稳定错误码（doctor / run 输出归因） */
export function classifyClientFailure(raw: string): { code: string; title: string } | undefined {
  const text = raw.toLowerCase()
  if (text.includes('unauthorized') || text.includes('401') || text.includes('api key')) {
    return { code: 'RUNTIME_KEY_UNAUTHORIZED', title: 'Runtime API Key 无法使用这个 Tunnel，请检查 OpenAI Platform 中 Runtime API Key 对 Tunnel 的权限。' }
  }
  if (text.includes('permission') || text.includes('403')) {
    return { code: 'TUNNEL_PERMISSION_DENIED', title: '当前凭据没有该 Tunnel 的权限，请在 OpenAI Platform 检查 Tunnel 与 Runtime API Key 的绑定。' }
  }
  if (text.includes('tunnel') && text.includes('not') && text.includes('found')) {
    return { code: 'TUNNEL_ID_INVALID', title: '找不到这个 Tunnel ID，请回到 OpenAI Platform 核对后重新填写。' }
  }
  if (text.includes('econnrefused') || text.includes('enotfound') || text.includes('etimedout') || text.includes('network')) {
    return { code: 'NETWORK_UNREACHABLE', title: '无法连接 OpenAI 网络，请检查本机网络或代理设置后重试。' }
  }
  if (text.includes('invalid') && text.includes('tunnel')) {
    return { code: 'TUNNEL_ID_INVALID', title: 'Tunnel ID 格式不正确，应以 tunnel_ 开头。' }
  }
  return undefined
}

export class OpenAiTunnelClientAdapter implements TunnelClientAdapter {
  buildVersionArgs(): string[] {
    return ['--version']
  }

  buildDoctorArgs(input: TunnelRuntimeConfig): string[] {
    return [
      'doctor',
      '--control-plane.tunnel-id', input.tunnelId,
      '--mcp.server-url', input.mcpServerUrl,
    ]
  }

  buildRunArgs(input: TunnelRuntimeConfig): string[] {
    return [
      'run',
      '--control-plane.tunnel-id', input.tunnelId,
      '--mcp.server-url', input.mcpServerUrl,
      '--health.listen-addr', input.healthListenAddr,
      '--health.url-file', input.healthUrlFile,
    ]
  }

  parseVersion(output: string): string | undefined {
    return parseVersionOutput(output)
  }

  parseDoctor(raw: TunnelDoctorRaw, version?: string): TunnelDoctorResult {
    const failure = classifyClientFailure(raw.stdout + '\n' + raw.stderr)
    const checks: TunnelDoctorResult['checks'] = [
      { name: 'OpenAI Tunnel Client', ok: true, ...(version ? { message: version } : {}) },
      { name: 'Tunnel 配置', ok: !failure, ...(failure ? { message: failure.title } : {}) },
      { name: 'OpenAI 网络', ok: !(failure?.code === 'NETWORK_UNREACHABLE') },
      { name: 'Runtime API Key', ok: !(failure?.code === 'RUNTIME_KEY_UNAUTHORIZED' || failure?.code === 'TUNNEL_PERMISSION_DENIED') },
    ]
    return {
      ok: raw.exitCode === 0,
      checks,
      technical: { exitCode: raw.exitCode, stdout: raw.stdout.slice(0, 8000), stderr: raw.stderr.slice(0, 4000), ...(version ? { version } : {}) },
    }
  }
}

export const openAiTunnelClientAdapter: TunnelClientAdapter = new OpenAiTunnelClientAdapter()
