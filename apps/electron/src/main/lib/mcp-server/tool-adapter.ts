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
import { workspaceListTool, readManyTool, gitStatusBatchTool, CROSS_SEARCH_SCHEMA_PROPERTIES } from './multi-workspace'

/** tools/list 的单个工具视图（含注解与跨仓库 schema 增强） */
export interface McpToolView {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
  }
}

function toolAnnotations(risk: LocalToolRisk): McpToolView['annotations'] {
  return {
    readOnlyHint: risk === 'read',
    destructiveHint: risk !== 'read',
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
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: toolAnnotations(tool.risk),
    })
  }
  // 多工作区固定工具（schema 稳定，仓库只是运行时参数——规范 §43）
  views.push({ name: workspaceListTool.name, description: workspaceListTool.description, inputSchema: workspaceListTool.inputSchema, annotations: toolAnnotations(workspaceListTool.risk) })
  if (config.tools.fileRead) {
    views.push({ name: readManyTool.name, description: readManyTool.description, inputSchema: readManyTool.inputSchema, annotations: toolAnnotations(readManyTool.risk) })
  }
  if (config.tools.git) {
    views.push({ name: gitStatusBatchTool.name, description: gitStatusBatchTool.description, inputSchema: gitStatusBatchTool.inputSchema, annotations: toolAnnotations(gitStatusBatchTool.risk) })
  }
  return views
}

/** 工具名集合（设置页摘要用）：当前配置下可见的所有工具名 */
export function visibleToolNames(config: PromaMcpServerConfig, registry: LocalToolRegistry): Set<string> {
  return new Set(buildMcpToolViews(config, registry).map((view) => view.name))
}
