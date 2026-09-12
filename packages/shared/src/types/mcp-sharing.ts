import type { PromaMcpServerToolToggles } from './mcp-server'
export type McpShareSource = { type: 'agent-workspace'; agentWorkspaceId: string } | { type: 'local-folder'; path: string }
export interface McpShareRoot {
  id: string; name: string; source: McpShareSource; enabled: boolean
  permissions: { read: boolean; write: boolean; shell: boolean }
  createdAt: number
}
export interface McpAgentTarget { id: string; channelId: string; modelId: string; enabled: boolean; priority: number }
export interface McpAgentAttempt { targetId: string; startedAt: number; endedAt: number; resultType: 'completed' | 'failed' | 'cancelled' }
export type McpAgentActionMode = 'analysis' | 'approval' | 'direct'
export interface McpAgentActionPolicy {
  mode: McpAgentActionMode
  write: boolean
  execute: boolean
}
export interface McpDelegationConfig {
  enabled: boolean; strategy: 'fallback' | 'round-robin' | 'manual'
  targets: McpAgentTarget[]; maxConcurrent: number; maxQueued: number
  /** V3：Agent 动作独立于 ChatGPT Direct Tool 的策略；缺省按只读分析处理。 */
  action?: McpAgentActionPolicy
  /** 只供旧配置迁移，运行时使用 targets。 */
  channelId?: string; modelId?: string
}
export interface McpSharingConfig {
  /** 当前持久化格式为 3；2 仅用于旧调用方的类型兼容，normalizer 总是返回 3。 */
  version: 2 | 3; enabled: boolean; roots: McpShareRoot[]
  localEndpoint: { enabled: boolean; port: number | 'auto'; auth: 'none' | 'managed-bearer' }
  tools: PromaMcpServerToolToggles
  policy: { read: 'direct' | 'disabled'; write: 'disabled' | 'approval' | 'direct'; execute: 'disabled' | 'approval' | 'direct' }
  limits: { writeConcurrent: number; writeCallsPerMinute: number; shellCallsPerMinute: number }
  delegation: McpDelegationConfig
}
export interface McpShareRootHealth {
  id: string; kind: 'managed-project' | 'local-project' | 'extra-folder'; state: 'available' | 'missing' | 'denied'
  path?: string; message?: string
}
export type McpAgentCapabilityState = 'available' | 'disabled' | 'workspace_denied' | 'target_unavailable' | 'unknown'
export interface McpEffectiveCapability {
  read: boolean
  write: boolean
  execute: boolean
  agentAnalysis: McpAgentCapabilityState
  agentAction: McpAgentCapabilityState
}
export interface McpCapabilitySummary {
  schemaVersion: 1
  direct: { tools: string[]; read: boolean; write: boolean; execute: boolean }
  agent: { enabled: boolean; mode: 'disabled' | 'analysis' | 'approval' | 'direct'; tools: string[]; targetReadiness: 'ready' | 'unavailable' | 'unknown'; readyTargetCount: number; checkedAt?: number }
}
export interface McpWorkspaceCapabilityView {
  id: string
  name: string
  git: boolean
  branch?: string
  health: 'available' | 'missing' | 'denied'
  permissions: { read: boolean; write: boolean; shell: boolean }
  effective: McpEffectiveCapability
}
export interface McpWorkspaceListResult {
  capabilities: McpCapabilitySummary
  workspaces: McpWorkspaceCapabilityView[]
  count: number
}
export interface McpRemoteTask {
  id: string; workspaceId: string; sessionId?: string; createdAt: number; updatedAt: number
  /** 旧任务缺失时按 analysis 读取。 */
  kind?: 'analysis' | 'action'
  status: 'queued' | 'planning' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
  summary?: string; changed_files: string[]; warnings: string[]
  approval?: { required: boolean; requestedAt?: number; decidedAt?: number; decision?: 'approved' | 'denied' }
  errorCode?: string
  targetId?: string; attempts?: McpAgentAttempt[]
}
export const MCP_SHARING_IPC = {
  GET: 'mcp-sharing:get', SAVE: 'mcp-sharing:save', PICK_FOLDER: 'mcp-sharing:pick-folder',
  PICK_FOLDERS: 'mcp-sharing:pick-folders',
  VALIDATE_TARGETS: 'mcp-sharing:validate-targets',
  LINK_PROJECT: 'mcp-sharing:link-project', CHANGED: 'mcp-sharing:changed',
  TASKS: 'mcp-sharing:tasks', CANCEL_TASK: 'mcp-sharing:cancel-task',
  APPROVE_TASK: 'mcp-sharing:approve-task', DENY_TASK: 'mcp-sharing:deny-task',
} as const
