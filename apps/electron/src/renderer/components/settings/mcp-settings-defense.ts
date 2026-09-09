/**
 * MCP 设置页渲染层防御工具（白屏修复专项）。
 *
 * 原则（修复文档 §13-§16/§24）：
 * - 渲染层 normalize 不是安全边界——Main 的 normalizePromaMcpServerConfig() 才是；
 *   这里只保证「IPC 响应缺字段 / 旧 preload / schema drift」不把页面打崩；
 * - Tunnel 旧状态（status/clientInstalled）迁移为新结构或回退安全默认；
 * - preload 能力按存在性检测，缺失时降级而非抛错。
 */

import type { PromaMcpServerConfig, PromaMcpTunnelState } from '@proma/shared'

export const DEFAULT_MCP_CONFIG: PromaMcpServerConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 'auto',
  workspaces: [],
  profiles: [],
  accessMode: 'read-only',
  tools: { fileRead: true, fileWrite: false, search: true, git: true, shell: false },
  auth: { type: 'none' },
}

/** Tunnel 状态渲染层安全回退（TC-BLANK-06） */
export const FALLBACK_TUNNEL_STATE: PromaMcpTunnelState = {
  phase: 'stopped',
  client: { installed: false },
  localMcpReady: false,
  runtimeKeyConfigured: false,
}

/** 最低级防御 normalize：保证 JSX 依赖的数组/对象字段必然存在（§14） */
export function normalizeRendererMcpConfig(raw: unknown): PromaMcpServerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_MCP_CONFIG }
  const partial = raw as Partial<PromaMcpServerConfig>
  return {
    ...DEFAULT_MCP_CONFIG,
    ...partial,
    workspaces: Array.isArray(partial.workspaces) ? partial.workspaces : [],
    profiles: Array.isArray(partial.profiles) ? partial.profiles : [],
    tools: { ...DEFAULT_MCP_CONFIG.tools, ...(partial.tools ?? {}) },
    auth: { ...DEFAULT_MCP_CONFIG.auth, ...(partial.auth ?? {}) },
  }
}

/**
 * Tunnel 状态防御（§15/§16）：
 * - 新结构（phase/client）→ 原样返回（补齐缺省 client 字段）；
 * - 旧结构（status/clientInstalled）→ 迁移；
 * - 无法识别 → 安全回退 stopped + 未安装，绝不让 JSX 访问 undefined。
 */
export function normalizeTunnelState(raw: unknown): PromaMcpTunnelState {
  if (!raw || typeof raw !== 'object') return { ...FALLBACK_TUNNEL_STATE }
  const candidate = raw as Partial<PromaMcpTunnelState> & {
    status?: unknown
    clientInstalled?: unknown
  }
  if (typeof candidate.phase !== 'string') {
    // 旧版 { status, clientInstalled } 迁移
    if (typeof candidate.status === 'string') {
      const legacyStatus = candidate.status
      const phase = legacyStatus === 'running' ? 'connected' : legacyStatus === 'error' ? 'error' : 'stopped'
      return {
        ...FALLBACK_TUNNEL_STATE,
        phase,
        client: { installed: candidate.clientInstalled === true },
      }
    }
    return { ...FALLBACK_TUNNEL_STATE }
  }
  const rawClient = candidate.client as Record<string, unknown> | undefined
  const client: PromaMcpTunnelState['client'] = rawClient && typeof rawClient === 'object'
    ? { ...(rawClient as unknown as PromaMcpTunnelState['client']), installed: rawClient.installed === true }
    : { installed: false }
  return {
    ...FALLBACK_TUNNEL_STATE,
    ...candidate,
    client,
  } as PromaMcpTunnelState
}

/** 本页依赖的 preload 能力清单（§8/§23；只记录存在性，不记录敏感数据） */
export interface McpApiCapabilities {
  bridgeVersion: number | null
  getState: boolean
  stateEvents: boolean
  installClient: boolean
  detectClient: boolean
  doctor: boolean
  saveConfig: boolean
  pickExecutable: boolean
}

export function getMcpApiCapabilities(): McpApiCapabilities {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  return {
    bridgeVersion: typeof api?.bridgeVersion === 'number' ? api.bridgeVersion : null,
    getState: typeof api?.getMcpTunnelState === 'function',
    stateEvents: typeof api?.onMcpTunnelStateChanged === 'function',
    installClient: typeof api?.installMcpTunnelClient === 'function',
    detectClient: typeof api?.detectMcpTunnelClient === 'function',
    doctor: typeof api?.runMcpTunnelDoctor === 'function',
    saveConfig: typeof api?.saveMcpTunnelConfig === 'function',
    pickExecutable: typeof api?.pickMcpTunnelExecutable === 'function',
  }
}

/** 本页要求的最低 bridge 版本（V6 §33） */
export const REQUIRED_MCP_BRIDGE_VERSION = 10

/** bridge 版本过旧判定：无法读取版本时视为兼容（避免误伤旧 preload 的基础能力） */
export function isBridgeOutdated(capabilities: McpApiCapabilities): boolean {
  return capabilities.bridgeVersion !== null && capabilities.bridgeVersion < REQUIRED_MCP_BRIDGE_VERSION
}
