/** 本机与 Public Ingress 共用工具配置/分发；不注册 Transport 自有工具。 */
import type { PromaMcpServerConfig } from '@proma/shared'
import type { LocalToolRegistry, LocalToolResult } from '../local-tools'
import { buildMcpToolViews } from './tool-adapter'
import type { McpToolHandlers } from './protocol/modern-server'
import { resolveTargetWorkspace, assertToolPermission, handleWorkspaceList, handleReadMany, handleGitStatusBatch, handleCrossWorkspaceSearch, type WorkspaceDirectoryEntry, type WorkspaceContextResolver } from './multi-workspace'

export interface ConfiguredToolsInput {
  config(): PromaMcpServerConfig
  entries(): WorkspaceDirectoryEntry[]
  resolve: WorkspaceContextResolver
  registry: LocalToolRegistry
  allowedNames?: ReadonlySet<string>
  onCall?(name: string): void
}

export function createConfiguredTools(input: ConfiguredToolsInput): McpToolHandlers {
  const list = () => buildMcpToolViews(input.config(), input.registry).filter((t) => !input.allowedNames || input.allowedNames.has(t.name))
  const dispatch = async (name: string, args: Record<string, unknown>): Promise<LocalToolResult> => {
    if (!list().some((t) => t.name === name)) return { ok: false, error: { code: 'PERMISSION_DENIED', message: '工具未启用' } }
    const entries = input.entries().filter((e) => e.enabled)
    const resolve: WorkspaceContextResolver = (id) => entries.some((e) => e.id === id) ? input.resolve(id) : { error: 'workspace 不在当前 endpoint 的授权范围内' }
    if (name === 'workspace_list') return handleWorkspaceList(entries)
    if (name === 'read_many') return handleReadMany(args, entries, resolve, input.registry)
    if (name === 'git_status_batch') return handleGitStatusBatch(args, entries, resolve, input.registry)
    if (name === 'search_text' && Array.isArray(args.workspace_ids) && args.workspace_ids.length > 0) return handleCrossWorkspaceSearch(args, entries, resolve, input.registry)
    const definition = input.registry.get(name)
    if (!definition) return { ok: false, error: { code: 'INVALID_INPUT', message: '未知工具' } }
    const target = resolveTargetWorkspace(args.workspace_id, entries)
    if ('error' in target) return { ok: false, error: target.error }
    const denied = assertToolPermission(definition.risk, target.entry.permissions)
    if (denied) return { ok: false, error: denied }
    const resolved = resolve(target.entry.id)
    if ('error' in resolved) return { ok: false, error: { code: 'INVALID_INPUT', message: resolved.error } }
    const toolArgs = { ...args }
    delete toolArgs.workspace_id; delete toolArgs.workspace_ids
    return definition.execute(toolArgs, resolved.context)
  }
  return { list, call: async (name, args) => {
    const result = await dispatch(name, args)
    input.onCall?.(name)
    return { content: [{ type: 'text', text: result.text ?? JSON.stringify(result.ok ? result.data ?? {} : result.error) }],
      ...(result.ok && result.data ? { structuredContent: result.data } : {}), isError: !result.ok }
  } }
}
