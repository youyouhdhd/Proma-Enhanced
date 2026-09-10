/**
 * 本地工具注册表类型定义
 *
 * 统一 Pi Agent 与 MCP Server 两条消费路径的本地能力抽象：
 * 一个工具定义，两个适配器（PiToolAdapter / McpToolAdapter）。
 * 工具实现只操作真实环境（文件/搜索/Git/Shell），绝不调用模型。
 */

/** 工具执行上下文：绑定到某个 Proma 工作区 */
export interface LocalToolContext {
  workspaceId: string
  /** 工作区根目录（绝对路径，已解析） */
  rootPath: string
  signal?: AbortSignal
}

export type LocalToolRisk = 'read' | 'write' | 'execute'

/** 工具执行结果：ok 时带 data/text，失败时带可读错误码 */
export interface LocalToolResult {
  ok: boolean
  data?: Record<string, unknown>
  /** 模型可读的文本形式（MCP text content） */
  text?: string
  error?: {
    code: 'PATH_OUTSIDE_WORKSPACE' | 'PATH_NOT_FOUND' | 'BINARY_FILE' | 'MATCH_NOT_FOUND' | 'MATCH_NOT_UNIQUE' | 'INVALID_INPUT' | 'WORKSPACE_REQUIRED' | 'EXECUTION_ERROR' | 'TIMEOUT' | 'ABORTED' | 'GIT_ERROR' | 'PERMISSION_DENIED'
    message: string
    choices?: Array<{ workspace_id: string; name: string }>
  }
}

/**
 * 本地工具定义
 *
 * inputSchema 使用 JSON Schema（draft 2020-12 子集），直接透出给 MCP tools/list。
 */
export interface LocalToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  risk: LocalToolRisk
  execute(input: Record<string, unknown>, context: LocalToolContext): Promise<LocalToolResult>
}

/** 构造失败结果的便捷函数 */
export function toolError(code: NonNullable<LocalToolResult['error']>['code'], message: string): LocalToolResult {
  return { ok: false, error: { code, message } }
}

/** 构造成功结果的便捷函数 */
export function toolOk(data: Record<string, unknown>, text?: string): LocalToolResult {
  return { ok: true, data, ...(text !== undefined ? { text } : {}) }
}
