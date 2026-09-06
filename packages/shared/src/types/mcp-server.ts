/**
 * PROMA MCP Server（供 ChatGPT Web 等外部 MCP Client 调用）
 *
 * 第二轮架构：一个 MCP Gateway 管理多个 Workspace。
 * - 工具固定（workspace_list / read_file / write_file / search_text / git_diff / …），仓库只是参数；
 * - 每个 Workspace 有独立读写执行权限；
 * - 不存在全局 activeWorkspace，工具调用始终显式携带 workspace_id（单工作区时才可省略）；
 * - 工具执行期间绝不触发 Pi / Codex / 任何模型调用。
 */

// ===== 工具 ID =====

/** MCP Server 暴露的工具标识（与 LocalToolRegistry 注册名 + 多工作区工具一致） */
export type PromaMcpToolId =
  | 'workspace_list'
  | 'workspace_info'
  | 'list_files'
  | 'read_file'
  | 'read_many'
  | 'search_text'
  | 'find_files'
  | 'git_status'
  | 'git_status_batch'
  | 'git_diff'
  | 'write_file'
  | 'edit_file'
  | 'shell_execute'

// ===== Workspace 注册表 =====

/** 单个 Workspace 的工具权限（按仓库独立管理，不做全局 Full Access） */
export interface PromaMcpWorkspacePermissions {
  read: boolean
  write: boolean
  shell: boolean
}

/** 注册到 MCP Gateway 的一个 Workspace（引用 Proma Agent 工作区） */
export interface PromaMcpWorkspaceEntry {
  /** 稳定标识：ws_ + 8 位哈希（从 agentWorkspaceId 派生，重开应用不变） */
  id: string
  /** 引用的 Proma Agent 工作区 id（rootPath 启动/调用时解析） */
  agentWorkspaceId: string
  /** 可选展示名（缺省用 Agent 工作区名） */
  name?: string
  enabled: boolean
  permissions: PromaMcpWorkspacePermissions
  createdAt: number
}

/**
 * Connection Profile：同一 Gateway 上按 endpoint 隔离的 Workspace 子集。
 * 例：/mcp/personal → 个人项目；/mcp/work → 工作项目。底层仍是一个 HTTP Server。
 */
export interface PromaMcpConnectionProfile {
  id: string
  name: string
  workspaceIds: string[]
  enabled: boolean
}

// ===== 配置 =====

/** MCP Server 认证方式 */
export type PromaMcpAuthType = 'none' | 'bearer'

/** MCP Server 各工具组开关 */
export interface PromaMcpServerToolToggles {
  /** 文件读取类（read_file / list_files / find_files / read_many） */
  fileRead: boolean
  /** 文件写入类（write_file / edit_file） */
  fileWrite: boolean
  /** 文本搜索（search_text，含跨仓库） */
  search: boolean
  /** Git 只读（git_status / git_diff / git_status_batch） */
  git: boolean
  /** Shell 执行（高风险，默认关闭） */
  shell: boolean
}

/** MCP Server 配置（持久化到 settings.json 的 mcpServer 字段） */
export interface PromaMcpServerConfig {
  enabled: boolean
  host: '127.0.0.1'
  /** 固定端口或自动选择 */
  port: number | 'auto'
  /** 已废弃：迁移期兼容字段，读取时合并进 workspaces[0] */
  workspaceId?: string
  /** Workspace 注册表（多仓库；空列表表示未授权任何项目） */
  workspaces: PromaMcpWorkspaceEntry[]
  /** Connection Profiles（高级功能；默认空） */
  profiles: PromaMcpConnectionProfile[]
  /** 全局访问模式：read-only 时写/执行工具对任何 Workspace 都不可见 */
  accessMode: 'read-only' | 'full'
  tools: PromaMcpServerToolToggles
  auth: {
    type: PromaMcpAuthType
    token?: string
  }
}

// ===== 状态 =====

/** 运行中的 Workspace 摘要（设置页展示） */
export interface PromaMcpWorkspaceSummary {
  id: string
  name: string
  enabled: boolean
  /** 该 workspace 是否可用（Agent 工作区存在且根目录有效） */
  available: boolean
  permissions: PromaMcpWorkspacePermissions
}

/** MCP Server 运行状态 */
export interface PromaMcpServerStatus {
  running: boolean
  host: string
  port: number
  /** 完整 endpoint，如 http://127.0.0.1:8787/mcp */
  endpoint: string
  activeSessions: number
  /** 已授权 Workspace 摘要 */
  workspaces: PromaMcpWorkspaceSummary[]
  /** Profile 端点（仅列出已启用的） */
  profileEndpoints: Array<{ id: string; name: string; endpoint: string }>
  /** 最近一次错误（启动失败等） */
  errorMessage?: string
}

/** 工具摘要（设置页展示） */
export interface PromaMcpToolSummary {
  name: PromaMcpToolId | string
  description: string
  risk: 'read' | 'write' | 'execute'
  /** 是否在当前配置下启用 */
  enabled: boolean
}

// ===== OpenAI Secure MCP Tunnel =====

/** Tunnel 集成配置（settings.json 的 mcpTunnel 字段） */
export interface PromaMcpTunnelSettings {
  /** OpenAI Platform 创建的 Tunnel ID，如 tunnel_xxx */
  tunnelId?: string
  /** tunnel-client 启动命令（默认 "tunnel-client"，可指向自定义路径） */
  clientCommand?: string
}

export type PromaMcpTunnelStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'error'

export interface PromaMcpTunnelState {
  status: PromaMcpTunnelStatus
  /** tunnel-client 是否可在 PATH/指定路径找到 */
  clientInstalled: boolean
  tunnelId?: string
  pid?: number
  /** 最近一次错误或退出原因（绝不包含 Runtime API Key） */
  message?: string
}

// ===== IPC 通道 =====

export const MCP_SERVER_IPC_CHANNELS = {
  GET_STATUS: 'mcp-server:get-status',
  START: 'mcp-server:start',
  STOP: 'mcp-server:stop',
  UPDATE_CONFIG: 'mcp-server:update-config',
  LIST_TOOLS: 'mcp-server:list-tools',
  GET_TUNNEL_STATE: 'mcp-server:get-tunnel-state',
  START_TUNNEL: 'mcp-server:start-tunnel',
  STOP_TUNNEL: 'mcp-server:stop-tunnel',
  SAVE_TUNNEL_RUNTIME_KEY: 'mcp-server:save-tunnel-runtime-key',
  RUN_TUNNEL_DOCTOR: 'mcp-server:run-tunnel-doctor',
} as const
