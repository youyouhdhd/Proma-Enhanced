import { createHash } from 'node:crypto'
import type { McpSharingConfig } from '@proma/shared'
import { createConfiguredTools } from '../mcp-server/configured-tools'
import { normalizePromaMcpServerConfig } from '../mcp-server/config'
import { createDefaultLocalToolRegistry } from '../local-tools/registry'
import type { McpToolHandlers } from '../mcp-server/protocol/modern-server'
import type { WorkspaceDirectoryEntry, WorkspaceContextResolver } from '../mcp-server/multi-workspace'
import type { AnalysisTaskQueue } from './task-queue'
import { canExposeTool, canCallTool, RemoteExecutionGuard } from './tool-policy'
import { resolveTargetWorkspace } from '../mcp-server/multi-workspace'

export const DELEGATION_TOOL_NAMES = new Set(['proma_task_start', 'proma_task_status', 'proma_task_result', 'proma_task_cancel'])
export function createPrimitiveCatalog(config: () => McpSharingConfig, entries: () => WorkspaceDirectoryEntry[], resolve: WorkspaceContextResolver, remote = true, guard = new RemoteExecutionGuard()): McpToolHandlers {
  const registry = createDefaultLocalToolRegistry()
  const primitive = (signal?: AbortSignal) => createConfiguredTools({ registry,
    config: () => normalizePromaMcpServerConfig({ accessMode: 'full', tools: config().tools }),
    entries, resolve, signal: () => signal })
  const risk = (name: string) => registry.get(name)?.risk ?? 'read'
  const list = () => config().enabled ? primitive().list().filter((tool) => !remote || canExposeTool(risk(tool.name), config())).map((tool) => ({ ...tool, description: tool.description + ' 直接工具，不启动 PROMA 模型。' })) : []
  return { list, call: async (name, args) => {
    if (!list().some((tool) => tool.name === name)) return { content: [{ type: 'text', text: '工具未启用或权限策略已关闭' }], isError: true }
    const level = risk(name)
    if (!remote || level === 'read') return primitive().call(name, args)
    const target = resolveTargetWorkspace(args.workspace_id, entries())
    if ('error' in target) return { content: [{ type: 'text', text: JSON.stringify(target.error) }], isError: true }
    if (!canCallTool(level, target.entry, config())) return { content: [{ type: 'text', text: 'PERMISSION_DENIED：项目未授权此能力' }], isError: true }
    let lease: ReturnType<RemoteExecutionGuard['acquire']> | undefined
    try {
      lease = guard.acquire(level, target.entry.id, config())
      return await primitive(lease.signal).call(name, args)
    } catch (error) { return { content: [{ type: 'text', text: error instanceof Error ? error.message : '远程操作失败' }], isError: true } }
    finally { lease?.release() }
  } }
}
export function withDelegation(primitive: McpToolHandlers, enabled: () => boolean, queue: AnalysisTaskQueue): McpToolHandlers {
  const views = [...DELEGATION_TOOL_NAMES].map((name) => ({ name,
    description: name === 'proma_task_start' ? '将多步骤只读分析交给 PROMA 已配置的 Agent 模型，会产生额外模型费用。快速返回 task_id；用 status/result 查询。额外文件夹需先关联 PROMA 项目。' : name === 'proma_task_cancel' ? '停止一个 PROMA 分析任务。' : '查询 PROMA 分析任务的状态或简短结果，不返回内部事件日志。',
    inputSchema: { type: 'object', properties: name === 'proma_task_start' ? { workspace_id: { type: 'string' }, instruction: { type: 'string', minLength: 1, maxLength: 12000 }, target_id: { type: 'string', description: 'Manual 策略下必须指定已启用目标 ID' } } : { task_id: { type: 'string' } }, required: name === 'proma_task_start' ? ['workspace_id', 'instruction'] : ['task_id'], additionalProperties: false },
    annotations: { readOnlyHint: name === 'proma_task_status' || name === 'proma_task_result', destructiveHint: false },
  }))
  return { list: () => [...primitive.list(), ...(enabled() ? views : [])], call: async (name, args) => {
    if (!DELEGATION_TOOL_NAMES.has(name)) return primitive.call(name, args)
    try {
      if (!enabled()) throw new Error('PROMA 分析未启用')
      if (name === 'proma_task_start') {
        if (typeof args.workspace_id !== 'string' || typeof args.instruction !== 'string') throw new Error('参数无效')
        const task = queue.start(args.workspace_id, args.instruction, typeof args.target_id === 'string' ? args.target_id : undefined)
        return { content: [{ type: 'text', text: JSON.stringify({ task_id: task.id, status: task.status }) }] }
      }
      if (typeof args.task_id !== 'string') throw new Error('参数无效')
      let task = queue.get(args.task_id)
      if (name === 'proma_task_cancel') { queue.cancel(task.id); task = queue.get(task.id) }
      const result = name === 'proma_task_result' ? { task_id: task.id, status: task.status, summary: task.summary ?? '', changed_files: task.changed_files, warnings: task.warnings } : { task_id: task.id, status: task.status, updatedAt: task.updatedAt }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) { return { content: [{ type: 'text', text: error instanceof Error ? error.message : '任务操作失败' }], isError: true } }
  } }
}
export function toolFingerprint(tools: McpToolHandlers): string {
  return createHash('sha256').update(JSON.stringify(tools.list().toSorted((a, b) => a.name.localeCompare(b.name)))).digest('hex')
}
