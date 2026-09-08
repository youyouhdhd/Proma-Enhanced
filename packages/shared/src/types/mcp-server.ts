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
export type PromaMcpAuthType = 'none' | 'bearer' | 'managed-bearer'

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
    /** 仅 bearer（自定义）模式使用；managed-bearer 的 Secret 存 safeStorage，不落 settings */
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
  /** 最近一次工具调用（供「第一次测试」成功判定展示） */
  lastToolCall?: { name: string; at: number }
  /** 最近 MCP 请求观测（环形缓冲，设置页展示；V5 §10） */
  recentRequests: PromaMcpRequestTrace[]
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

// ===== OpenAI Secure MCP Tunnel（第三轮：Tunnel Client 产品化） =====

/** OpenAI Tunnel Client 的来源模式（不再是任意命令行） */
export type PromaMcpTunnelClientMode =
  | 'managed'        // PROMA 自动安装和管理（推荐）
  | 'custom-path'    // 用户指定的本地可执行文件
  | 'system-path'    // 由系统 PATH 查找（高级）

/** Tunnel 集成配置（settings.json 的 mcpTunnel 字段） */
export interface PromaMcpTunnelSettings {
  /** OpenAI Platform 创建的 Tunnel ID，如 tunnel_xxx */
  tunnelId?: string
  mode: PromaMcpTunnelClientMode
  /** mode=custom-path 时的本地可执行文件位置（只允许本地文件路径，禁止 URL） */
  executablePath?: string
  /** PROMA 启动后自动恢复连接；默认关闭，须用户显式开启 */
  autoConnect?: boolean
  /** 已废弃：旧版 clientCommand；读取时一次性迁移到 mode / executablePath */
  clientCommand?: string
}

/** Tunnel 生命周期阶段（以真实 /readyz 为准，不存在"存活 8 秒 = 已连接"） */
export type PromaMcpTunnelPhase =
  | 'not-installed'   // Tunnel Client 未安装
  | 'needs-config'    // 缺少 Tunnel ID / Runtime Key / 本地 MCP 未运行
  | 'preflight'       // 检查配置中
  | 'starting'        // 已启动进程
  | 'waiting-ready'   // 进程存活，等待 /readyz
  | 'connected'       // /readyz = 200
  | 'stopping'
  | 'stopped'
  | 'error'

/** Tunnel Client 程序信息 */
export interface PromaMcpTunnelClientInfo {
  installed: boolean
  version?: string
  path?: string
  source?: 'managed' | 'custom' | 'system-path'
  errorCode?: string
  errorMessage?: string
}

/** Tunnel 运行状态（经 mcp-tunnel:state-changed 实时推送给渲染层） */
export interface PromaMcpTunnelState {
  phase: PromaMcpTunnelPhase
  client: PromaMcpTunnelClientInfo
  localMcpReady: boolean
  tunnelId?: string
  runtimeKeyConfigured: boolean
  /** 凭据健康（V6 §26）：available 才算已安全保存；unreadable 需要重新保存 */
  runtimeKeyStatus?: PromaMcpRuntimeKeyStatus
  healthUrl?: string
  pid?: number
  lastConnectedAt?: number
  /** 面向用户的错误：发生了什么 + 下一步；原始 stderr 放 detail 或走 doctor */
  error?: { code: string; title: string; detail?: string; action?: string }
}

/** Runtime API Key 凭据健康状态（V6 §26：文件存在但解密失败 ≠ 可用） */
export type PromaMcpRuntimeKeyStatus = 'missing' | 'available' | 'unreadable'

/** 程序检测结果（检测按钮 / 安装完成后返回） */
export interface PromaMcpTunnelDetection {
  installed: boolean
  /**
   * 可执行文件类型（V5 §8）：完整 CLI（含 doctor/run 子命令）才能用于诊断与启动；
   * tunnel-client-runtime.exe 之类的 runtime-only 包会被明确拒绝。
   */
  executableKind?: 'full-cli' | 'runtime-only' | 'unknown'
  path?: string
  version?: string
  source?: 'managed' | 'custom' | 'system-path'
  errorCode?: string
  errorMessage?: string
}

/** 单个诊断项状态（V5 §6）：exit != 0 时未验证项不得显示绿色 */
export type PromaMcpDiagnosticState = 'pass' | 'fail' | 'unknown' | 'skipped'

/** Doctor 结构化诊断（技术详情单独放，UI 默认折叠） */
export interface PromaMcpTunnelDoctorResult {
  ok: boolean
  checks: Array<{ name: string; state: PromaMcpDiagnosticState; ok: boolean; message?: string }>
  /** 阻断 ChatGPT Connector 的失败项（V6 §25：codex_plugin / ui SKIP 不算阻断） */
  blockingFailures?: string[]
  technical?: { exitCode?: number; stdout?: string; stderr?: string; version?: string; healthUrl?: string }
}

/** 单条 MCP 请求观测记录（V5 §10；不含任何敏感头 / 参数） */
export interface PromaMcpRequestTrace {
  at: number
  method: string
  path: string
  hasSessionId: boolean
  jsonRpcMethod?: string
  protocolVersion?: string
  statusCode: number
  /** 本机认证结果（V6 §19）：请求即使被 401/403 拒绝也必须留下观测 */
  authResult?: 'not-required' | 'accepted' | 'rejected'
  /** 非敏感请求头（V7 §19：content-type / accept / mcp-protocol-version / mcp-method / mcp-name / user-agent） */
  requestMetadata?: {
    contentType?: string
    accept?: string
    protocolVersionHeader?: string
    mcpMethod?: string
    mcpName?: string
    userAgent?: string
  }
  /** JSON-RPC 错误码（V7 §20：-32601 Method not found 等；HTTP 200 也可能携带 RPC error） */
  rpcErrorCode?: number
}

/** MCP 请求方法直方图（V7 §5/§6：确认 ChatGPT 实际发了什么） */
export interface PromaMcpMethodStats {
  total: number
  methods: Record<string, number>
  statuses: Record<string, number>
  discoverCount: number
  initializeCount: number
  toolsListCount: number
  toolsCallCount: number
  unknownCount: number
}

/** ChatGPT Connector 创建失败时的端到端诊断（V5 §13） */
export interface PromaMcpConnectorDiagnosis {
  generatedAt: number
  /** 诊断窗口起点（V6 §28）：只统计该时间之后的请求，避免历史干扰 */
  windowStartedAt: number
  checks: Array<{ name: string; state: PromaMcpDiagnosticState; message?: string }>
  /** CASE A：请求未到达；CASE B-AUTH：被本机认证拒绝；CASE B-DISCOVER：server/discover 失败；CASE B-HANDSHAKE：discovery 前置完成但未进 tools/list；CASE B-PROTOCOL：tools/list 失败；CASE C：tools/list 200 */
  conclusion?: { id: 'A' | 'B-AUTH' | 'B-DISCOVER' | 'B-HANDSHAKE' | 'B-PROTOCOL' | 'C' | 'OK'; title: string; detail: string; action?: string }
  /** 请求方法直方图（V7 §6） */
  stats: PromaMcpMethodStats
}

/** Tunnel 专用 IPC 通道（第三轮起独立于 mcp-server:* 前缀） */
export const MCP_TUNNEL_IPC_CHANNELS = {
  GET_STATE: 'mcp-tunnel:get-state',
  START: 'mcp-tunnel:start',
  STOP: 'mcp-tunnel:stop',
  DIAGNOSE_CONNECTOR: 'mcp-tunnel:diagnose-connector',
  SAVE_CONFIG: 'mcp-tunnel:save-config',
  SAVE_RUNTIME_KEY: 'mcp-tunnel:save-runtime-key',
  CLEAR_RUNTIME_KEY: 'mcp-tunnel:clear-runtime-key',
  DETECT: 'mcp-tunnel:detect',
  INSTALL: 'mcp-tunnel:install',
  RUN_DOCTOR: 'mcp-tunnel:run-doctor',
  PICK_EXECUTABLE: 'mcp-tunnel:pick-executable',
  STATE_CHANGED: 'mcp-tunnel:state-changed',
} as const

// ===== IPC 通道 =====

export const MCP_SERVER_IPC_CHANNELS = {
  GET_STATUS: 'mcp-server:get-status',
  START: 'mcp-server:start',
  STOP: 'mcp-server:stop',
  UPDATE_CONFIG: 'mcp-server:update-config',
  LIST_TOOLS: 'mcp-server:list-tools',
} as const
