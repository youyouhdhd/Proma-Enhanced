/** MCP Server 配置规范化（settings.json 反序列化入口） */

import type { PromaMcpConnectionProfile, PromaMcpServerConfig, PromaMcpWorkspaceEntry } from '@proma/shared'

export const DEFAULT_PROMA_MCP_SERVER_CONFIG: PromaMcpServerConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 'auto',
  workspaces: [],
  profiles: [],
  accessMode: 'read-only',
  tools: { fileRead: true, fileWrite: false, search: true, git: true, shell: false },
  auth: { type: 'none' },
}

/** FNV-1a 32 位哈希 → 8 位十六进制。workspace id 从 agentWorkspaceId 确定性派生，重开应用保持稳定。 */
export function deriveWorkspaceId(agentWorkspaceId: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < agentWorkspaceId.length; i++) {
    hash ^= agentWorkspaceId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return 'ws_' + (hash >>> 0).toString(16).padStart(8, '0')
}

function normalizeWorkspaceEntry(raw: unknown): PromaMcpWorkspaceEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const entry = raw as Partial<PromaMcpWorkspaceEntry>
  if (typeof entry.agentWorkspaceId !== 'string' || !entry.agentWorkspaceId) return undefined
  const permissions = (entry.permissions ?? {}) as Partial<PromaMcpWorkspaceEntry['permissions']>
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : deriveWorkspaceId(entry.agentWorkspaceId),
    agentWorkspaceId: entry.agentWorkspaceId,
    ...(typeof entry.name === 'string' && entry.name ? { name: entry.name } : {}),
    enabled: entry.enabled !== false,
    permissions: {
      read: permissions.read !== false,
      write: permissions.write === true,
      shell: permissions.shell === true,
    },
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
  }
}

function normalizeProfileEntry(raw: unknown): PromaMcpConnectionProfile | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const profile = raw as Partial<PromaMcpConnectionProfile>
  if (typeof profile.id !== 'string' || !profile.id) return undefined
  if (typeof profile.name !== 'string' || !profile.name) return undefined
  if (!Array.isArray(profile.workspaceIds)) return undefined
  return {
    id: profile.id,
    name: profile.name,
    workspaceIds: profile.workspaceIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
    enabled: profile.enabled !== false,
  }
}

/**
 * 深度规范化：未知输入一律回退安全默认值（read-only、shell 关闭、空注册表）。
 * 兼容迁移：旧配置的单一 workspaceId 会合并进 workspaces[0]，权限从 accessMode 派生。
 */
export function normalizePromaMcpServerConfig(input: unknown): PromaMcpServerConfig {
  if (!input || typeof input !== 'object') return { ...DEFAULT_PROMA_MCP_SERVER_CONFIG }
  const raw = input as Partial<PromaMcpServerConfig>
  const tools = (raw.tools ?? {}) as Partial<PromaMcpServerConfig['tools']>
  const auth = (raw.auth ?? {}) as Partial<PromaMcpServerConfig['auth']>
  const accessMode: PromaMcpServerConfig['accessMode'] = raw.accessMode === 'full' ? 'full' : 'read-only'

  let workspaces = Array.isArray(raw.workspaces)
    ? raw.workspaces.map(normalizeWorkspaceEntry).filter((e): e is PromaMcpWorkspaceEntry => e !== undefined)
    : []
  // 旧单工作区配置迁移（只在没有任何新格式数据时生效，避免覆盖用户编辑）
  if (workspaces.length === 0 && typeof raw.workspaceId === 'string' && raw.workspaceId) {
    workspaces = [{
      id: deriveWorkspaceId(raw.workspaceId),
      agentWorkspaceId: raw.workspaceId,
      enabled: true,
      permissions: {
        read: true,
        write: accessMode === 'full' && tools.fileWrite === true,
        shell: accessMode === 'full' && tools.shell === true,
      },
      createdAt: Date.now(),
    }]
  }
  // 同一 agentWorkspaceId 只保留一个条目（后写覆盖先写）
  const byAgentWorkspace = new Map<string, PromaMcpWorkspaceEntry>()
  for (const entry of workspaces) byAgentWorkspace.set(entry.agentWorkspaceId, entry)
  workspaces = [...byAgentWorkspace.values()]

  const profiles = Array.isArray(raw.profiles)
    ? raw.profiles.map(normalizeProfileEntry).filter((p): p is PromaMcpConnectionProfile => p !== undefined)
    : []

  return {
    enabled: raw.enabled === true,
    host: '127.0.0.1',
    port: raw.port === 'auto' || (typeof raw.port === 'number' && raw.port > 0 && raw.port <= 65535) ? raw.port : 'auto',
    ...(typeof raw.workspaceId === 'string' && raw.workspaceId ? { workspaceId: raw.workspaceId } : {}),
    workspaces,
    profiles,
    accessMode,
    tools: {
      fileRead: tools.fileRead !== false,
      fileWrite: tools.fileWrite === true,
      search: tools.search !== false,
      git: tools.git !== false,
      shell: tools.shell === true,
    },
    auth: auth.type === 'managed-bearer'
      ? { type: 'managed-bearer' }
      : auth.type === 'bearer' && typeof auth.token === 'string' && auth.token.length > 0
        ? { type: 'bearer', token: auth.token }
        : { type: 'none' },
  }
}
