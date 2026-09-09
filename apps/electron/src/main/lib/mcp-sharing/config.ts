import type { McpSharingConfig, McpShareRoot, PromaMcpServerConfig } from '@proma/shared'
import { normalizePromaMcpServerConfig } from '../mcp-server/config'

export function migrateSharing(old: PromaMcpServerConfig): McpSharingConfig {
  return { version: 1, enabled: old.enabled || old.workspaces.some((w) => w.enabled),
    roots: old.workspaces.map((w) => ({ id: w.id, name: w.name ?? w.agentWorkspaceId, source: { type: 'agent-workspace', agentWorkspaceId: w.agentWorkspaceId }, enabled: w.enabled, permissions: w.permissions, createdAt: w.createdAt })),
    localEndpoint: { enabled: old.enabled, port: old.port, auth: old.auth.type === 'none' ? 'none' : 'managed-bearer' },
    tools: old.tools, policy: { read: 'enabled', write: 'disabled', execute: 'disabled' }, delegation: { enabled: false } }
}
export function normalizeSharing(value: unknown): McpSharingConfig {
  if (!value || typeof value !== 'object') return migrateSharing(normalizePromaMcpServerConfig(undefined))
  const raw = value as Partial<McpSharingConfig>
  if (!Array.isArray(raw.roots) || raw.roots.length > 500) throw new Error('SHARING_ROOTS_INVALID')
  const seen = new Set<string>()
  const roots: McpShareRoot[] = raw.roots.map((r) => {
    if (!r || typeof r.id !== 'string' || !/^[\w-]{1,100}$/.test(r.id) || seen.has(r.id) || typeof r.name !== 'string' || !r.source) throw new Error('SHARING_ROOT_INVALID')
    seen.add(r.id)
    const source = r.source.type === 'agent-workspace' && typeof r.source.agentWorkspaceId === 'string' ? { type: 'agent-workspace' as const, agentWorkspaceId: r.source.agentWorkspaceId }
      : r.source.type === 'local-folder' && typeof r.source.path === 'string' ? { type: 'local-folder' as const, path: r.source.path } : undefined
    if (!source) throw new Error('SHARING_SOURCE_INVALID')
    return { id: r.id, name: r.name.slice(0, 200), source, enabled: r.enabled === true,
      permissions: { read: r.permissions?.read === true, write: r.permissions?.write === true, shell: r.permissions?.shell === true }, createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now() }
  })
  const port = raw.localEndpoint?.port ?? 'auto'
  if (port !== 'auto' && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('LOCAL_PORT_INVALID')
  return { version: 1, enabled: raw.enabled === true, roots,
    localEndpoint: { enabled: raw.localEndpoint?.enabled === true, port, auth: raw.localEndpoint?.auth === 'none' ? 'none' : 'managed-bearer' },
    tools: normalizePromaMcpServerConfig({ tools: raw.tools }).tools,
    policy: { read: raw.policy?.read === 'disabled' ? 'disabled' : 'enabled', write: 'disabled', execute: 'disabled' },
    delegation: { enabled: raw.delegation?.enabled === true, ...(typeof raw.delegation?.channelId === 'string' ? { channelId: raw.delegation.channelId } : {}), ...(typeof raw.delegation?.modelId === 'string' ? { modelId: raw.delegation.modelId } : {}) } }
}
