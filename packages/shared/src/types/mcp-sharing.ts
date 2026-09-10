import type { PromaMcpServerToolToggles } from './mcp-server'
export type McpShareSource = { type: 'agent-workspace'; agentWorkspaceId: string } | { type: 'local-folder'; path: string }
export interface McpShareRoot {
  id: string; name: string; source: McpShareSource; enabled: boolean
  permissions: { read: boolean; write: boolean; shell: boolean }
  createdAt: number
}
export interface McpAgentTarget { id: string; channelId: string; modelId: string; enabled: boolean; priority: number }
export interface McpAgentAttempt { targetId: string; startedAt: number; endedAt: number; resultType: 'completed' | 'failed' | 'cancelled' }
export interface McpDelegationConfig {
  enabled: boolean; strategy: 'fallback' | 'round-robin' | 'manual'
  targets: McpAgentTarget[]; maxConcurrent: number; maxQueued: number
  /** 只供旧配置迁移，运行时使用 targets。 */
  channelId?: string; modelId?: string
}
export interface McpSharingConfig {
  version: 2; enabled: boolean; roots: McpShareRoot[]
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
export interface McpRemoteTask {
  id: string; workspaceId: string; sessionId?: string; createdAt: number; updatedAt: number
  status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
  summary?: string; changed_files: string[]; warnings: string[]
  targetId?: string; attempts?: McpAgentAttempt[]
}
export const MCP_SHARING_IPC = {
  GET: 'mcp-sharing:get', SAVE: 'mcp-sharing:save', PICK_FOLDER: 'mcp-sharing:pick-folder',
  PICK_FOLDERS: 'mcp-sharing:pick-folders',
  VALIDATE_TARGETS: 'mcp-sharing:validate-targets',
  LINK_PROJECT: 'mcp-sharing:link-project', CHANGED: 'mcp-sharing:changed',
  TASKS: 'mcp-sharing:tasks', CANCEL_TASK: 'mcp-sharing:cancel-task',
} as const
