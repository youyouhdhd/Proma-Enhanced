/**
 * PROMA MCP Server 模块入口
 *
 * 独立于 MCP Client（pi-mcp-tools）：
 *   external MCP servers ▲ MCP Client ▲ PROMA ▼ MCP Server ▼ ChatGPT Web
 * 两条链路不共享任何类，只共享 LocalToolRegistry。
 */

export { PromaMcpServer } from './server'
export { normalizePromaMcpServerConfig, DEFAULT_PROMA_MCP_SERVER_CONFIG, deriveWorkspaceId } from './config'
export { buildMcpToolViews, visibleToolNames, type McpToolView } from './tool-adapter'
export { SessionManager } from './session-manager'
export {
  handleWorkspaceList,
  handleReadMany,
  handleGitStatusBatch,
  handleCrossWorkspaceSearch,
  resolveTargetWorkspace,
  assertToolPermission,
  type WorkspaceDirectoryEntry,
  type WorkspaceContextResolver,
} from './multi-workspace'
export { createDefaultLocalToolRegistry, LocalToolRegistry } from '../local-tools/registry'
