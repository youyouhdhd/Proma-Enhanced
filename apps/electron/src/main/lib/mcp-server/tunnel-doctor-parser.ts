/**
 * tunnel-doctor-parser — 官方 doctor 输出解析（V5 §6）
 *
 * 优先解析官方结构化行：
 *   CHECK <name> PASS <message>
 *   CHECK <name> FAIL <message>
 *   CHECK <name> SKIP <message>
 * 解析不出 CHECK 行时（旧版本 / 纯文本输出）→ 全部检查项归为 unknown，
 * 绝不在 exit != 0 时虚构绿色结果（TC-V5-DOC-01）。
 */

import type { PromaMcpDiagnosticState, PromaMcpTunnelDoctorResult } from '@proma/shared'

export interface ParsedDoctorCheck {
  /** 官方 CHECK 名称（保留原样，供技术详情对照） */
  rawName: string
  /** 用户可读名称 */
  name: string
  state: PromaMcpDiagnosticState
  message?: string
}

/** 官方 CHECK 名称 → 用户可读名称（未知的保留原名） */
const CHECK_NAME_MAP: Record<string, string> = {
  control_plane_api_key: 'Runtime API Key',
  control_plane_connection: 'OpenAI 网络',
  tunnel: 'Tunnel 配置',
  mcp_server: 'PROMA MCP',
  secure_tunnel_ready: 'Secure Tunnel Ready',
  permissions: 'Tunnel 权限',
}

function toUserState(official: string): PromaMcpDiagnosticState | undefined {
  const upper = official.toUpperCase()
  if (upper === 'PASS') return 'pass'
  if (upper === 'FAIL') return 'fail'
  if (upper === 'SKIP') return 'skipped'
  return undefined
}

/** 从 doctor 输出解析检查项（stdout + stderr 合并扫描） */
export function parseDoctorChecks(stdout: string, stderr: string): ParsedDoctorCheck[] {
  const checks: ParsedDoctorCheck[] = []
  const seen = new Set<string>()
  const lines = (stdout + '\n' + stderr).split(/\r?\n/)
  for (const line of lines) {
    const match = /^\s*CHECK\s+([\w.-]+)\s+(PASS|FAIL|SKIP)\s*(.*)$/i.exec(line)
    if (!match) continue
    const rawName = match[1]!
    if (seen.has(rawName)) continue
    seen.add(rawName)
    checks.push({
      rawName,
      name: CHECK_NAME_MAP[rawName.toLowerCase()] ?? rawName,
      state: toUserState(match[2]!) ?? 'unknown',
      ...(match[3]?.trim() ? { message: match[3]!.trim() } : {}),
    })
  }
  return checks
}

/**
 * 把解析结果组装成最终诊断：
 * - 官方 CHECK 有输出 → 按解析结果；
 * - exit != 0 且缺少对应 CHECK 行 → 该项 unknown（不标绿）；
 * - 已知失败关键词 → 对应项 fail。
 */
export function buildDoctorChecks(
  parsed: ParsedDoctorCheck[],
  exitCode: number | undefined,
  knownFailures: Array<{ name: string; message?: string }>,
  version?: string,
): PromaMcpTunnelDoctorResult['checks'] {
  const byName = new Map(parsed.map((c) => [c.rawName.toLowerCase(), c]))
  const failureByName = new Map(knownFailures.map((f) => [f.name, f]))
  const names = ['control_plane_api_key', 'tunnel', 'control_plane_connection', 'mcp_server', 'secure_tunnel_ready']
  const results: PromaMcpTunnelDoctorResult['checks'] = []
  // OpenAI Tunnel Client：version 已由 --version 单独验证
  results.push({ name: 'OpenAI Tunnel Client', state: version ? 'pass' : 'unknown', ok: Boolean(version), ...(version ? { message: version } : {}) })
  for (const key of names) {
    const parsedCheck = byName.get(key)
    const knownFail = failureByName.get(key)
    if (parsedCheck) {
      results.push({ name: parsedCheck.name, state: parsedCheck.state, ok: parsedCheck.state === 'pass', ...(parsedCheck.message ? { message: parsedCheck.message } : {}) })
      continue
    }
    if (knownFail) {
      results.push({ name: key === 'control_plane_api_key' ? 'Runtime API Key' : key, state: 'fail', ok: false, ...(knownFail.message ? { message: knownFail.message } : {}) })
      continue
    }
    // exit != 0 时未验证项 = unknown（绝不标绿）；exit === 0 时官方未列出的项按 pass 处理
    const passed = exitCode === 0
    results.push({
      name: key === 'control_plane_api_key' ? 'Runtime API Key' : key,
      state: passed ? 'pass' : 'unknown',
      ok: passed,
      ...(passed ? {} : { message: '未完成验证' }),
    })
  }
  return results
}
