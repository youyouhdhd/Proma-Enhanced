/**
 * OpenAiTunnelClientAdapter — 官方 tunnel-client CLI 封装（V5 更新）
 *
 * - 参数构造集中于此（--version / doctor / run / help 校验）；
 * - 错误分类严格区分 Missing / Unauthorized / Forbidden（V5 §5），杜绝「Key 未传入
 *   被误判成权限不足」；
 * - parseDoctor 接入 tunnel-doctor-parser：官方 CHECK 行优先，exit != 0 时
 *   未验证项归 unknown，绝不虚构绿色（V5 §6）。
 */

import type { PromaMcpTunnelDoctorResult } from '@proma/shared'
import type { TunnelDoctorRaw, TunnelDoctorResult, TunnelRuntimeConfig } from './tunnel-client-types'
import { buildDoctorChecks, computeBlockingFailures, parseDoctorChecks } from './tunnel-doctor-parser'

export interface TunnelClientAdapter {
  buildVersionArgs(): string[]
  /** 完整 CLI 校验：runtime-only 包没有 doctor 子命令（V5 §8） */
  buildDoctorHelpArgs(): string[]
  buildRunHelpArgs(): string[]
  buildDoctorArgs(input: TunnelRuntimeConfig): string[]
  buildRunArgs(input: TunnelRuntimeConfig): string[]
  parseVersion(output: string): string | undefined
  parseDoctor(raw: TunnelDoctorRaw, version?: string): TunnelDoctorResult
}

/** 稳定错误码 + 用户可读标题 + 下一步动作（V5 §5） */
export interface TunnelFailure {
  code: string
  title: string
  action?: string
}

export const TUNNEL_FAILURE_CODES = {
  RUNTIME_KEY_NOT_CONFIGURED: 'RUNTIME_KEY_NOT_CONFIGURED',
  RUNTIME_KEY_MISSING_IN_PROCESS: 'RUNTIME_KEY_MISSING_IN_PROCESS',
  RUNTIME_KEY_UNAUTHORIZED: 'RUNTIME_KEY_UNAUTHORIZED',
  TUNNEL_PERMISSION_DENIED: 'TUNNEL_PERMISSION_DENIED',
  TUNNEL_ID_INVALID: 'TUNNEL_ID_INVALID',
  NETWORK_UNREACHABLE: 'NETWORK_UNREACHABLE',
} as const

/**
 * 错误分类：先 Missing、再 Unauthorized、再 Forbidden（V5 §5 明确顺序）。
 * 「control plane API key is required」= 进程没收到 Key（注入问题），
 * 绝不能归类为权限不足。
 */
export function classifyClientFailure(raw: string): TunnelFailure | undefined {
  const text = raw.toLowerCase()

  // 1) Missing：Key 没有进入子进程
  if (
    text.includes('control plane api key is required') ||
    text.includes('api key is required') ||
    text.includes('missing api key')
  ) {
    return {
      code: TUNNEL_FAILURE_CODES.RUNTIME_KEY_MISSING_IN_PROCESS,
      title: 'OpenAI Tunnel Client 没有收到 Runtime API Key。',
      action: '检查 PROMA 的凭据注入；如果 Key 已保存，请重新启动连接。',
    }
  }

  // 2) Unauthorized：Key 无效（401）
  if (text.includes('unauthorized') || /\b401\b/.test(text)) {
    return {
      code: TUNNEL_FAILURE_CODES.RUNTIME_KEY_UNAUTHORIZED,
      title: 'Runtime API Key 无效或身份验证失败。',
      action: '重新创建 Runtime API Key 并保存。',
    }
  }

  // 3) Forbidden：Key 有效但无权使用该 Tunnel（403）
  if (text.includes('forbidden') || text.includes('permission') || /\b403\b/.test(text)) {
    return {
      code: TUNNEL_FAILURE_CODES.TUNNEL_PERMISSION_DENIED,
      title: '当前 Runtime API Key 没有使用这个 Tunnel 的权限。',
      action: '检查 Runtime Key 所属主体与当前用户是否拥有 Tunnels Read + Use 权限。',
    }
  }

  // 4) 其他
  if (text.includes('tunnel') && text.includes('not') && text.includes('found')) {
    return { code: TUNNEL_FAILURE_CODES.TUNNEL_ID_INVALID, title: '找不到这个 Tunnel ID，请回到 OpenAI Platform 核对后重新填写。', action: '重新填写 Tunnel ID' }
  }
  if (text.includes('econnrefused') || text.includes('enotfound') || text.includes('etimedout') || text.includes('network')) {
    return { code: TUNNEL_FAILURE_CODES.NETWORK_UNREACHABLE, title: '无法连接 OpenAI 网络，请检查本机网络或代理设置后重试。', action: '检查网络后重试' }
  }
  if (text.includes('invalid') && text.includes('tunnel')) {
    return { code: TUNNEL_FAILURE_CODES.TUNNEL_ID_INVALID, title: 'Tunnel ID 格式不正确，应以 tunnel_ 开头。', action: '重新填写 Tunnel ID' }
  }
  return undefined
}

/** 从 --version 输出中解析语义化版本 */
export function parseVersionOutput(output: string): string | undefined {
  const match = /v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(output)
  return match ? 'v' + match[1]! : undefined
}

export class OpenAiTunnelClientAdapter implements TunnelClientAdapter {
  buildVersionArgs(): string[] {
    return ['--version']
  }

  buildDoctorHelpArgs(): string[] {
    return ['doctor', '--help']
  }

  buildRunHelpArgs(): string[] {
    return ['run', '--help']
  }

  buildDoctorArgs(input: TunnelRuntimeConfig): string[] {
    return [
      'doctor',
      '--control-plane.tunnel-id', input.tunnelId,
      '--mcp.server-url', input.mcpServerUrl,
      // V6 §9/§16：doctor 与 run 使用相同的临时健康监听（127.0.0.1:0），避免 8080 冲突
      '--health.listen-addr', input.healthListenAddr,
      '--health.url-file', input.healthUrlFile,
      // V6 §14/§16：Local MCP 本机认证经 env 引用注入（doctor 同样需要）
      ...(input.localMcpAuth ? [
        '--mcp.extra-headers', 'Authorization: env:' + input.localMcpAuth.envVarName,
        '--mcp.discovery-extra-headers', 'Authorization: env:' + input.localMcpAuth.envVarName,
      ] : []),
    ]
  }

  buildRunArgs(input: TunnelRuntimeConfig): string[] {
    return [
      'run',
      '--control-plane.tunnel-id', input.tunnelId,
      '--mcp.server-url', input.mcpServerUrl,
      '--health.listen-addr', input.healthListenAddr,
      '--health.url-file', input.healthUrlFile,
      ...(input.localMcpAuth ? [
        '--mcp.extra-headers', 'Authorization: env:' + input.localMcpAuth.envVarName,
        '--mcp.discovery-extra-headers', 'Authorization: env:' + input.localMcpAuth.envVarName,
      ] : []),
    ]
  }

  parseVersion(output: string): string | undefined {
    return parseVersionOutput(output)
  }

  parseDoctor(raw: TunnelDoctorRaw, version?: string): TunnelDoctorResult {
    const combined = raw.stdout + '\n' + raw.stderr
    const failure = classifyClientFailure(combined)
    const parsed = parseDoctorChecks(raw.stdout, raw.stderr)
    // 已知失败关键词映射到对应检查项（v5 §5/§6）
    const knownFailures: Array<{ rawName: string; message?: string }> = []
    if (failure?.code === TUNNEL_FAILURE_CODES.RUNTIME_KEY_MISSING_IN_PROCESS || failure?.code === TUNNEL_FAILURE_CODES.RUNTIME_KEY_UNAUTHORIZED || failure?.code === TUNNEL_FAILURE_CODES.TUNNEL_PERMISSION_DENIED) {
      knownFailures.push({ rawName: 'control_plane_api_key', message: failure.title })
    }
    const checks = buildDoctorChecks(parsed, raw.exitCode, knownFailures, version)
    const blockingFailures = computeBlockingFailures(parsed, knownFailures)
    return {
      ok: raw.exitCode === 0,
      checks,
      blockingFailures,
      technical: { exitCode: raw.exitCode, stdout: raw.stdout.slice(0, 8000), stderr: raw.stderr.slice(0, 4000), ...(version ? { version } : {}) },
    }
  }
}

export const openAiTunnelClientAdapter: TunnelClientAdapter = new OpenAiTunnelClientAdapter()
