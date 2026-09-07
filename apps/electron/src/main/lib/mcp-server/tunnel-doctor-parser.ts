/**
 * tunnel-doctor-parser — 官方 doctor 输出解析（V6 §10 对齐官方真实 Check ID）
 *
 * 官方实际输出的 Check（v0.0.14 实测）：
 *   config_source / profile_load / tunnel_id / control_plane_api_key /
 *   tunnels_management_url / runtime_api_keys_url / admin_api_keys_url /
 *   chatgpt_connector_settings_url / mcp_target / mcp_server_reachable /
 *   oauth_metadata / health_listener / ui / codex_plugin
 *
 * 严禁继续使用 V5 时期虚构的 tunnel / control_plane_connection / mcp_server /
 * secure_tunnel_ready 作为期望项（那是「未完成验证」假阴性的来源）。
 * Secure Tunnel /readyz 属于运行态（Runtime Readiness），不伪装成 Doctor 检查。
 */

import type { PromaMcpConnectorDiagnosis, PromaMcpDiagnosticState, PromaMcpTunnelDoctorResult } from '@proma/shared'

export interface ParsedDoctorCheck {
  /** 官方 CHECK 名称（保留原样，供技术详情对照） */
  rawName: string
  /** 用户可读名称 */
  name: string
  state: PromaMcpDiagnosticState
  message?: string
}

/** 官方 CHECK 名称 → 用户可读名称（未知的保留原名） */
export const CHECK_NAME_MAP: Record<string, string> = {
  config_source: '配置来源',
  profile_load: '配置加载',
  tunnel_id: 'Tunnel ID',
  control_plane_api_key: 'Runtime API Key',
  tunnels_management_url: 'Tunnels 管理地址',
  runtime_api_keys_url: 'Runtime API Keys 地址',
  admin_api_keys_url: '管理密钥地址',
  chatgpt_connector_settings_url: 'ChatGPT Connector 设置地址',
  mcp_target: 'PROMA MCP 地址',
  mcp_server_reachable: 'PROMA MCP 可达性',
  oauth_metadata: 'PROMA MCP OAuth 元数据',
  health_listener: 'Tunnel 本地健康服务',
  ui: 'Tunnel 本地管理界面',
  codex_plugin: 'Codex Tunnel 插件',
}

/** 阻断 ChatGPT Connector 的关键 Check（V6 §25：ui / codex_plugin / oauth_metadata 不阻断） */
export const CRITICAL_CHECKS: readonly string[] = [
  'tunnel_id',
  'control_plane_api_key',
  'mcp_target',
  'mcp_server_reachable',
  'health_listener',
]

function toUserState(official: string): PromaMcpDiagnosticState | undefined {
  const upper = official.toUpperCase()
  if (upper === 'PASS') return 'pass'
  if (upper === 'FAIL') return 'fail'
  if (upper === 'SKIP') return 'skipped'
  return undefined
}

/** 从 doctor 输出解析官方 CHECK 行（stdout + stderr 合并扫描，同名校验去重） */
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
 * 组装最终诊断 checks：
 * - 有官方 CHECK 输出 → 原样映射（不做任何虚构补位）；
 * - 无 CHECK 输出且 exit != 0 → 归为 unknown（绝不标绿，TC-V5-DOC-01）；
 * - 已知失败关键词覆盖对应项为 fail。
 */
export function buildDoctorChecks(
  parsed: ParsedDoctorCheck[],
  exitCode: number | undefined,
  knownFailures: Array<{ rawName: string; message?: string }>,
  version?: string,
): PromaMcpTunnelDoctorResult['checks'] {
  const results: PromaMcpTunnelDoctorResult['checks'] = []
  results.push({ name: 'OpenAI Tunnel Client', state: version ? 'pass' : 'unknown', ok: Boolean(version), ...(version ? { message: version } : {}) })
  const failureByName = new Map(knownFailures.map((f) => [f.rawName.toLowerCase(), f]))
  if (parsed.length > 0) {
    for (const check of parsed) {
      const knownFail = failureByName.get(check.rawName.toLowerCase())
      const state = knownFail ? 'fail' as const : check.state
      results.push({
        name: check.name,
        state,
        ok: state === 'pass',
        ...(knownFail ? { message: knownFail.message } : check.message ? { message: check.message } : {}),
      })
    }
    return results
  }
  // 无 CHECK 输出：未知归 unknown
  for (const knownFail of knownFailures) {
    results.push({ name: CHECK_NAME_MAP[knownFail.rawName] ?? knownFail.rawName, state: 'fail', ok: false, ...(knownFail.message ? { message: knownFail.message } : {}) })
  }
  results.push({ name: 'Doctor 输出', state: 'unknown', ok: false, message: '无法解析官方输出（原始内容见技术详情）' })
  return results
}

/** 阻断 Connector 的失败项（关键 Check 中 state=fail 的名称） */
export function computeBlockingFailures(parsed: ParsedDoctorCheck[], knownFailures: Array<{ rawName: string }>): string[] {
  const blocking = new Set<string>()
  for (const check of parsed) {
    if (check.state === 'fail' && CRITICAL_CHECKS.includes(check.rawName.toLowerCase())) {
      blocking.add(check.name)
    }
  }
  for (const knownFail of knownFailures) {
    if (CRITICAL_CHECKS.includes(knownFail.rawName.toLowerCase())) {
      blocking.add(CHECK_NAME_MAP[knownFail.rawName] ?? knownFail.rawName)
    }
  }
  return [...blocking]
}

/** Connector 结论归类（V6 §20；纯函数便于回归测试） */
export interface ConnectorConclusionInput {
  recentCount: number
  allRejected: boolean
  toolsListCount: number
  toolsListOk: boolean
  doctorOk: boolean
}

export function classifyConnectorConclusion(
  input: ConnectorConclusionInput,
): PromaMcpConnectorDiagnosis['conclusion'] {
  if (input.recentCount === 0) {
    return {
      id: 'A',
      title: 'CASE A：PROMA 没有收到任何 MCP 请求',
      detail: '问题更可能位于 ChatGPT → Tunnel 段：请确认 ChatGPT 的 App 选择的是同一个 Tunnel、Workspace 绑定正确、Tunnel 用户权限（Tunnels Read + Use）已具备。',
      action: '核对 ChatGPT Connector 的 Tunnel 选择，然后重试创建',
    }
  }
  if (input.allRejected) {
    return {
      id: 'B-AUTH',
      title: 'CASE B-AUTH：ChatGPT 请求已到达 PROMA，但被本地 MCP 认证拒绝',
      detail: 'Tunnel 链路是通的。可能原因：① PROMA MCP 开启了 Bearer Authentication；② Tunnel Client 没有注入 Authorization Header；③ Local MCP 认证配置修改后未重启。',
      action: '点击「检查配置并连接」让 PROMA 重新以正确凭据启动 Tunnel Client',
    }
  }
  if (input.toolsListCount === 0) {
    return {
      id: 'A',
      title: 'CASE A：收到了请求但没有 tools/list',
      detail: 'ChatGPT 侧的 discovery 尚未发起 tools/list。请确认 Connector 创建流程走到了「扫描 Tools」一步，然后重试。',
      action: '在 ChatGPT 重新创建 Connector',
    }
  }
  if (!input.toolsListOk) {
    return {
      id: 'B-PROTOCOL',
      title: 'CASE B-PROTOCOL：tools/list 返回失败',
      detail: '问题位于 PROMA MCP 协议 / Tool Schema 层。请展开技术详情查看状态码，并把最近请求反馈给开发者。',
      action: '重试一次；若持续失败请导出诊断信息',
    }
  }
  if (!input.doctorOk) {
    return {
      id: 'C',
      title: 'CASE C：tools/list 已成功但 Doctor 仍有失败项',
      detail: 'MCP discovery 正常；请按上方 Doctor 失败项处理（通常是 Runtime Key 权限或网络）。',
      action: '按 Doctor 失败项提示处理',
    }
  }
  return {
    id: 'OK',
    title: '链路各层正常',
    detail: '本地 MCP、Tunnel Client、Runtime Key、tools/list 均验证通过。若 ChatGPT 仍创建失败，请检查协议版本与 ChatGPT 侧约束，稍后重试。',
  }
}
