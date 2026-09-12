import type { McpSharingConfig, McpShareRoot, PromaMcpServerConfig } from '@proma/shared'
import { normalizePromaMcpServerConfig } from '../mcp-server/config'
import { createHash } from 'node:crypto'

export function migrateSharing(old: PromaMcpServerConfig): McpSharingConfig {
  return { version: 3, enabled: old.enabled || old.workspaces.some((w) => w.enabled),
    roots: old.workspaces.map((w) => ({ id: w.id, name: w.name ?? w.agentWorkspaceId, source: { type: 'agent-workspace', agentWorkspaceId: w.agentWorkspaceId }, enabled: w.enabled, permissions: w.permissions, createdAt: w.createdAt })),
    localEndpoint: { enabled: old.enabled, port: old.port, auth: old.auth.type === 'none' ? 'none' : 'managed-bearer' },
    tools: old.tools, policy: { read: 'direct', write: 'disabled', execute: 'disabled' }, limits: { writeConcurrent: 2, writeCallsPerMinute: 60, shellCallsPerMinute: 10 }, delegation: { enabled: false, strategy: 'fallback', targets: [], maxConcurrent: 1, maxQueued: 3, action: { mode: 'analysis', write: false, execute: false } } }
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
  const mode = (value: unknown) => value === 'direct' || value === 'approval' ? value : 'disabled'
  const actionMode = raw.delegation?.action?.mode === 'approval' || raw.delegation?.action?.mode === 'direct' ? raw.delegation.action.mode : 'analysis'
  const action = {
    mode: actionMode,
    write: raw.version === 3 && actionMode !== 'analysis' && raw.delegation?.action?.write === true,
    execute: raw.version === 3 && actionMode !== 'analysis' && raw.delegation?.action?.execute === true,
  } as const
  const limit = (value: unknown, fallback: number, max: number, min = 1) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
  const oldDelegation = raw.delegation
  const sourceTargets = Array.isArray(oldDelegation?.targets) ? oldDelegation.targets : oldDelegation?.channelId && oldDelegation?.modelId
    ? [{ id: 'target_' + createHash('sha256').update(oldDelegation.channelId + '\0' + oldDelegation.modelId).digest('hex').slice(0, 16), channelId: oldDelegation.channelId, modelId: oldDelegation.modelId, enabled: true, priority: 0 }] : []
  if (sourceTargets.length > 100) throw new Error('AGENT_TARGETS_INVALID')
  const targetIds = new Set<string>()
  const targets = sourceTargets.map((target, index) => {
    if (!target || typeof target.id !== 'string' || !/^[\w-]{1,100}$/.test(target.id) || targetIds.has(target.id) || typeof target.channelId !== 'string' || typeof target.modelId !== 'string') throw new Error('AGENT_TARGET_INVALID')
    targetIds.add(target.id)
    return { id: target.id, channelId: target.channelId, modelId: target.modelId, enabled: target.enabled === true, priority: Number.isFinite(target.priority) ? target.priority : index }
  })
  return { version: 3, enabled: raw.enabled === true, roots,
    localEndpoint: { enabled: raw.localEndpoint?.enabled === true, port, auth: raw.localEndpoint?.auth === 'none' ? 'none' : 'managed-bearer' },
    tools: normalizePromaMcpServerConfig({ tools: raw.tools }).tools,
    policy: { read: raw.policy?.read === 'disabled' ? 'disabled' : 'direct', write: raw.version === 2 || raw.version === 3 ? mode(raw.policy?.write) : 'disabled', execute: raw.version === 2 || raw.version === 3 ? mode(raw.policy?.execute) : 'disabled' },
    limits: { writeConcurrent: limit(raw.limits?.writeConcurrent, 2, 8), writeCallsPerMinute: limit(raw.limits?.writeCallsPerMinute, 60, 600), shellCallsPerMinute: limit(raw.limits?.shellCallsPerMinute, 10, 60) },
    delegation: { enabled: oldDelegation?.enabled === true, targets, strategy: oldDelegation?.strategy === 'manual' || oldDelegation?.strategy === 'round-robin' ? oldDelegation.strategy : 'fallback', maxConcurrent: limit(oldDelegation?.maxConcurrent, 1, 4), maxQueued: limit(oldDelegation?.maxQueued, 3, 20, 0), action } }
}
