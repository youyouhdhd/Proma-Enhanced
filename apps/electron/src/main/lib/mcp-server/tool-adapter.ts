/**
 * McpToolAdapter — 按 Server 配置从 LocalToolRegistry 过滤可见工具（tools/list 视图）
 *
 * - accessMode=read-only：仅 read 风险工具；
 * - accessMode=full：按工具组开关放行 write/execute；
 * - 多工作区固定工具（workspace_list / read_many / git_status_batch）按对应开关并入；
 * - 工具注解（readOnlyHint / destructiveHint）帮助 ChatGPT 正确处理确认与权限（规范 §44）。
 */

import type { PromaMcpServerConfig } from '@proma/shared'
import type { LocalToolRegistry, LocalToolDefinition, LocalToolRisk } from '../local-tools'
import { workspaceListTool, workspaceListOutputSchema, workspaceOpenTool, readManyTool, gitStatusBatchTool, CROSS_SEARCH_SCHEMA_PROPERTIES } from './multi-workspace'

/** tools/list 的单个工具视图（含注解与跨仓库 schema 增强） */
export interface McpToolView {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    openWorldHint: boolean
    idempotentHint?: boolean
  }
}

const TOOL_TITLES: Record<string, string> = {
  workspace_info: '查看工作区信息',
  workspace_list: '列出授权工作区',
  workspace_open: '解析工作区',
  list_files: '列出文件',
  read_file: '读取文件',
  read_many: '批量读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  search_text: '搜索文本',
  find_files: '查找文件',
  git_status: '查看 Git 状态',
  git_status_batch: '批量查看 Git 状态',
  git_diff: '查看 Git Diff',
  shell_execute: '执行 Shell 命令',
}

export function toolTitle(name: string): string {
  return TOOL_TITLES[name] ?? name
}

function toolAnnotations(risk: LocalToolRisk): McpToolView['annotations'] {
  return {
    readOnlyHint: risk === 'read',
    destructiveHint: risk !== 'read',
    openWorldHint: risk === 'execute',
    ...(risk === 'read' ? { idempotentHint: true } : {}),
  }
}

function isRegistryToolVisible(config: PromaMcpServerConfig, tool: LocalToolDefinition): boolean {
  if (tool.name === 'workspace_info') return true
  if (tool.risk === 'read') {
    if (tool.name === 'search_text') return config.tools.search
    if (tool.name === 'git_status' || tool.name === 'git_diff') return config.tools.git
    return config.tools.fileRead
  }
  if (tool.risk === 'write') return config.accessMode === 'full' && config.tools.fileWrite
  return config.accessMode === 'full' && config.tools.shell
}

/** 全量可见工具视图（MCP tools/list 直接使用） */
export function buildMcpToolViews(config: PromaMcpServerConfig, registry: LocalToolRegistry): McpToolView[] {
  const views: McpToolView[] = []
  for (const tool of registry.list()) {
    if (!isRegistryToolVisible(config, tool)) continue
    if (tool.name === 'search_text' && config.tools.search) {
      // 跨仓库搜索：为 search_text 注入 workspace_ids 参数（规范 §36）
      const schema = tool.inputSchema as { properties?: Record<string, unknown>; description?: string }
      views.push({
        name: tool.name,
        title: toolTitle(tool.name),
        description: tool.description + ' 支持传 workspace_ids 跨多个仓库搜索。',
        inputSchema: {
          ...tool.inputSchema,
          properties: { ...(schema.properties ?? {}), ...CROSS_SEARCH_SCHEMA_PROPERTIES },
        },
        annotations: toolAnnotations(tool.risk),
      })
      continue
    }
    views.push({
      name: tool.name,
      title: toolTitle(tool.name),
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: toolAnnotations(tool.risk),
    })
  }
  // 多工作区固定工具（schema 稳定，仓库只是运行时参数——规范 §43）
  views.push({ name: workspaceListTool.name, title: toolTitle(workspaceListTool.name), description: workspaceListTool.description, inputSchema: workspaceListTool.inputSchema, outputSchema: workspaceListOutputSchema, annotations: toolAnnotations(workspaceListTool.risk) })
  views.push({ name: workspaceOpenTool.name, title: toolTitle(workspaceOpenTool.name), description: workspaceOpenTool.description, inputSchema: workspaceOpenTool.inputSchema, annotations: toolAnnotations(workspaceOpenTool.risk) })
  if (config.tools.fileRead) {
    views.push({ name: readManyTool.name, title: toolTitle(readManyTool.name), description: readManyTool.description, inputSchema: readManyTool.inputSchema, annotations: toolAnnotations(readManyTool.risk) })
  }
  if (config.tools.git) {
    views.push({ name: gitStatusBatchTool.name, title: toolTitle(gitStatusBatchTool.name), description: gitStatusBatchTool.description, inputSchema: gitStatusBatchTool.inputSchema, annotations: toolAnnotations(gitStatusBatchTool.risk) })
  }
  return views
}

/** 工具名集合（设置页摘要用）：当前配置下可见的所有工具名 */
export function visibleToolNames(config: PromaMcpServerConfig, registry: LocalToolRegistry): Set<string> {
  return new Set(buildMcpToolViews(config, registry).map((view) => view.name))
}
