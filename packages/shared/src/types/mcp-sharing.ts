import type { PromaMcpServerToolToggles } from './mcp-server'
export type McpShareSource = { type: 'agent-workspace'; agentWorkspaceId: string } | { type: 'local-folder'; path: string }
export interface McpShareRoot {
  id: string; name: string; source: McpShareSource; enabled: boolean
  permissions: { read: boolean; write: boolean; shell: boolean }
  createdAt: number
}
export interface McpSharingConfig {
  version: 1; enabled: boolean; roots: McpShareRoot[]
  localEndpoint: { enabled: boolean; port: number | 'auto'; auth: 'none' | 'managed-bearer' }
  tools: PromaMcpServerToolToggles
  policy: { read: 'enabled' | 'disabled'; write: 'disabled'; execute: 'disabled' }
  delegation: { enabled: boolean; channelId?: string; modelId?: string }
}
export interface McpShareRootHealth {
  id: string; kind: 'managed-project' | 'local-project' | 'extra-folder'; state: 'available' | 'missing' | 'denied'
  path?: string; message?: string
}
export interface McpRemoteTask {
  id: string; workspaceId: string; sessionId?: string; createdAt: number; updatedAt: number
  status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
  summary?: string; changed_files: string[]; warnings: string[]
}
export const MCP_SHARING_IPC = {
  GET: 'mcp-sharing:get', SAVE: 'mcp-sharing:save', PICK_FOLDER: 'mcp-sharing:pick-folder',
  LINK_PROJECT: 'mcp-sharing:link-project', CHANGED: 'mcp-sharing:changed',
  TASKS: 'mcp-sharing:tasks', CANCEL_TASK: 'mcp-sharing:cancel-task',
} as const
