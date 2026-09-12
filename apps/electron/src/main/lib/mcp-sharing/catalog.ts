import { createHash } from 'node:crypto'
import type { CallToolResult } from '@modelcontextprotocol/server'
import type { McpAgentActionMode, McpCapabilitySummary, McpEffectiveCapability, McpSharingConfig, McpWorkspaceListResult } from '@proma/shared'
import { createConfiguredTools } from '../mcp-server/configured-tools'
import { normalizePromaMcpServerConfig } from '../mcp-server/config'
import { createDefaultLocalToolRegistry } from '../local-tools/registry'
import type { McpToolHandlers } from '../mcp-server/protocol/modern-server'
import type { WorkspaceDirectoryEntry, WorkspaceContextResolver } from '../mcp-server/multi-workspace'
import type { AnalysisTaskQueue } from './task-queue'
import { canExposeTool, canCallTool, RemoteExecutionGuard } from './tool-policy'
import { resolveTargetWorkspace } from '../mcp-server/multi-workspace'
import { PROMA_MCP_INSTRUCTIONS, PROMA_MCP_MANIFEST_VERSION } from '../mcp-server/protocol/server-instructions'

export const DELEGATION_TOOL_NAMES = new Set(['proma_task_start', 'proma_task_status', 'proma_task_result', 'proma_task_cancel', 'proma_action_start'])

const defaultAction = { mode: 'analysis' as const, write: false, execute: false }
const DATA_READ_TOOLS = new Set(['read_file', 'read_many', 'list_files', 'find_files', 'search_text', 'git_status', 'git_status_batch', 'git_diff'])

function getAction(config: McpSharingConfig): { mode: McpAgentActionMode; write: boolean; execute: boolean } {
  const action = config.delegation.action ?? defaultAction
  return { mode: action.mode, write: action.mode !== 'analysis' && action.write === true, execute: action.mode !== 'analysis' && action.execute === true }
}

function actionToolEnabled(config: McpSharingConfig): boolean {
  const action = getAction(config)
  return config.enabled && config.delegation.enabled && action.mode !== 'analysis' && (action.write || action.execute)
}

function errorResult(message: string, code?: string): CallToolResult {
  return { content: [{ type: 'text', text: code ? JSON.stringify({ code, message }) : message }], isError: true }
}

function taskErrorCode(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : undefined
}

function capabilityState(config: McpSharingConfig, entry: WorkspaceDirectoryEntry, kind: 'analysis' | 'action', directRead: boolean, action: ReturnType<typeof getAction>, readiness?: { state: 'ready' | 'unavailable' | 'unknown' }, actionVisible = true): McpEffectiveCapability['agentAnalysis'] {
  if (kind === 'analysis' && !config.delegation.enabled) return 'disabled'
  if (kind === 'action' && (!actionToolEnabled(config) || !actionVisible)) return 'disabled'
  if (!entry.agentWorkspaceId || !entry.enabled || !entry.permissions.read) return 'workspace_denied'
  if (kind === 'action' && !action.write && !action.execute) return 'disabled'
  if (kind === 'action' && !(action.write && entry.permissions.write || action.execute && entry.permissions.shell)) return 'workspace_denied'
  if (!directRead) return 'workspace_denied'
  if (readiness?.state === 'unavailable') return 'target_unavailable'
  if (readiness?.state === 'ready') return 'available'
  // 目标模型授权是异步检查；workspace_list 不调用模型，unknown 代表需实际调用或本地检查确认。
  return 'unknown'
}

function asWorkspaceList(value: unknown): McpWorkspaceListResult | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { workspaces?: unknown; count?: unknown }
  if (!Array.isArray(candidate.workspaces) || typeof candidate.count !== 'number') return undefined
  return candidate as McpWorkspaceListResult
}

function withCapabilitySnapshot(
  result: CallToolResult,
  config: McpSharingConfig,
  visibleTools: Array<{ name: string }>,
  entries: WorkspaceDirectoryEntry[],
  readiness?: { state: 'ready' | 'unavailable' | 'unknown'; readyCount: number; checkedAt?: number },
): CallToolResult {
  const current = asWorkspaceList(result.structuredContent)
  if (!current) return result
  const registry = createDefaultLocalToolRegistry()
  const names = visibleTools.map((tool) => tool.name)
  const directNames = names.filter((name) => !DELEGATION_TOOL_NAMES.has(name))
  const direct = {
    tools: directNames,
    read: directNames.some((name) => registry.get(name)?.risk === 'read' && DATA_READ_TOOLS.has(name)),
    write: directNames.some((name) => registry.get(name)?.risk === 'write'),
    execute: directNames.some((name) => registry.get(name)?.risk === 'execute'),
  }
  const action = getAction(config)
  const agentTools = names.filter((name) => DELEGATION_TOOL_NAMES.has(name))
  const capabilities: McpCapabilitySummary = {
    schemaVersion: 1,
    direct,
    agent: {
      enabled: config.enabled && config.delegation.enabled,
      mode: config.delegation.enabled ? action.mode : 'disabled',
      tools: agentTools,
      targetReadiness: config.delegation.enabled ? readiness?.state ?? 'unknown' : 'unavailable',
      readyTargetCount: config.delegation.enabled ? readiness?.readyCount ?? 0 : 0,
      ...(readiness?.checkedAt ? { checkedAt: readiness.checkedAt } : {}),
    },
  }
  const workspaces = current.workspaces.map((workspace) => {
    const entry = entries.find((candidate) => candidate.id === workspace.id)
    const permissions = entry?.permissions ?? workspace.permissions
    const effective: McpEffectiveCapability = {
      read: direct.read && permissions.read,
      write: direct.write && permissions.write,
      execute: direct.execute && permissions.shell,
      agentAnalysis: entry ? capabilityState(config, entry, 'analysis', direct.read, action, readiness) : 'workspace_denied',
      agentAction: entry ? capabilityState(config, entry, 'action', direct.read, action, readiness, agentTools.includes('proma_action_start')) : 'workspace_denied',
    }
    return { ...workspace, health: 'available' as const, permissions, effective }
  })
  const snapshot: McpWorkspaceListResult = { capabilities, workspaces, count: workspaces.length }
  return { ...result, structuredContent: snapshot, content: [{ type: 'text', text: JSON.stringify(snapshot) }] }
}

export function createPrimitiveCatalog(
  config: () => McpSharingConfig,
  entries: () => WorkspaceDirectoryEntry[],
  resolve: WorkspaceContextResolver,
  remote = true,
  guard = new RemoteExecutionGuard(),
  origin: 'direct' | 'agent' = 'direct',
): McpToolHandlers {
  const registry = createDefaultLocalToolRegistry()
  const primitive = (signal?: AbortSignal) => createConfiguredTools({
    registry,
    config: () => normalizePromaMcpServerConfig({ accessMode: 'full', tools: config().tools }),
    entries,
    resolve,
    signal: () => signal,
  })
  const risk = (name: string) => registry.get(name)?.risk ?? 'read'
  const list = () => config().enabled
    ? primitive().list().filter((tool) => !remote || canExposeTool(risk(tool.name), config())).map((tool) => ({ ...tool, description: tool.description + ' 直接工具，不启动 PROMA 模型。' }))
    : []
  const callPrimitive = async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> => {
    if (!list().some((tool) => tool.name === name)) return errorResult('工具未启用或权限策略已关闭', 'CAPABILITY_NOT_EXPOSED')
    if (name === 'workspace_list') {
      const result = await primitive(signal).call(name, args)
      return withCapabilitySnapshot(result, config(), list(), entries())
    }
    const level = risk(name)
    if (!remote || level === 'read') return primitive(signal).call(name, args)
    const target = resolveTargetWorkspace(args.workspace_id, entries())
    if ('error' in target) return errorResult(JSON.stringify(target.error), target.error.code)
    if (!canCallTool(level, target.entry, config())) return errorResult('项目未授权此能力', 'PERMISSION_DENIED')
    let lease: ReturnType<RemoteExecutionGuard['acquire']> | undefined
    try {
      lease = guard.acquire(level, target.entry.id, config(), origin)
      return await primitive(lease.signal).call(name, args)
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : '远程操作失败')
    } finally {
      lease?.release()
    }
  }
  return { list, call: (name, args) => callPrimitive(name, args) }
}

interface DelegationOptions {
  actionMode?: () => McpAgentActionMode
  actionToolsEnabled?: () => boolean
  actionExecuteEnabled?: () => boolean
  agentReadiness?: () => { state: 'ready' | 'unavailable' | 'unknown'; readyCount: number; checkedAt?: number }
  config?: () => McpSharingConfig
  entries?: () => WorkspaceDirectoryEntry[]
}

function delegationViews(actionMode: McpAgentActionMode, actionEnabled: boolean, actionExecuteEnabled = false) {
  const base = (name: string) => {
    if (name === 'proma_task_start') return {
      name, title: '启动 PROMA Agent 分析',
      description: '当用户明确要求交给 PROMA Agent 进行多步骤只读分析时调用。工具可见表示本连接已开放 Agent 分析入口；实际调用仍核对 workspace、远程 Scope 和 Agent 目标授权。成功后使用 proma_task_status 查询，并在完成后调用 proma_task_result。',
      inputSchema: { type: 'object', properties: { workspace_id: { type: 'string', description: 'workspace_list 返回的项目 ID' }, instruction: { type: 'string', minLength: 1, maxLength: 12000, description: '自包含的分析目标与验收标准' }, target_id: { type: 'string', description: 'Manual 策略下必须指定已启用目标 ID' } }, required: ['workspace_id', 'instruction'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { task_id: { type: 'string' }, kind: { type: 'string' }, status: { type: 'string' }, approval_required: { type: 'boolean' } }, required: ['task_id', 'kind', 'status', 'approval_required'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }
    if (name === 'proma_action_start') return {
      name, title: '启动 PROMA Agent 动作',
      description: '当用户明确要求由 PROMA Agent 修改项目或执行多步骤动作时调用。仅在本工具可见且 workspace_list 返回允许时使用；根据本地策略立即执行或进入 waiting_approval，ChatGPT 不能替用户批准。成功后使用 proma_task_status 和 proma_task_result 跟踪终态。',
      inputSchema: { type: 'object', properties: { workspace_id: { type: 'string', description: 'workspace_list 返回且允许 Agent Action 的项目 ID' }, instruction: { type: 'string', minLength: 1, maxLength: 12000, description: '自包含的动作目标与验收标准' }, target_id: { type: 'string', description: 'Manual 策略下必须指定已启用目标 ID' } }, required: ['workspace_id', 'instruction'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { task_id: { type: 'string' }, kind: { type: 'string' }, status: { type: 'string' }, approval_required: { type: 'boolean' } }, required: ['task_id', 'kind', 'status', 'approval_required'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: actionExecuteEnabled },
    }
    if (name === 'proma_task_cancel') return { name, title: '取消 PROMA Agent 任务', description: '停止一个尚未完成的 PROMA Agent 分析或动作任务。不会批准或绕过权限。', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false }, outputSchema: { type: 'object', properties: { task_id: { type: 'string' }, status: { type: 'string' } }, required: ['task_id', 'status'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true } }
    if (name === 'proma_task_status') return { name, title: '查询 PROMA Agent 任务', description: '查询 PROMA Agent 分析或动作任务状态。waiting_approval 表示必须由用户在 PROMA 本地审批。', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false }, outputSchema: { type: 'object', properties: { task_id: { type: 'string' }, kind: { type: 'string' }, status: { type: 'string' }, updated_at: { type: 'number' }, approval_required: { type: 'boolean' } }, required: ['task_id', 'kind', 'status', 'updated_at', 'approval_required'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } }
    return { name, title: '获取 PROMA Agent 任务结果', description: '获取已完成 PROMA Agent 分析或动作任务的结构化摘要、变化文件和警告。', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false }, outputSchema: { type: 'object', properties: { task_id: { type: 'string' }, kind: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' }, changed_files: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } }, error_code: { type: 'string' } }, required: ['task_id', 'kind', 'status', 'summary', 'changed_files', 'warnings'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } }
  }
  const names = actionEnabled && actionMode !== 'analysis'
    ? ['proma_task_start', 'proma_task_status', 'proma_task_result', 'proma_task_cancel', 'proma_action_start']
    : ['proma_task_start', 'proma_task_status', 'proma_task_result', 'proma_task_cancel']
  return names.map((name) => base(name))
}

export function withDelegation(
  primitive: McpToolHandlers,
  enabled: () => boolean,
  queue: AnalysisTaskQueue,
  options: DelegationOptions = {},
): McpToolHandlers {
  const actionMode = options.actionMode ?? (() => 'analysis' as const)
  const actionEnabled = options.actionToolsEnabled ?? (() => actionMode() !== 'analysis')
  return {
    list: () => {
      if (!enabled()) return primitive.list()
      return [...primitive.list(), ...delegationViews(actionMode(), actionEnabled(), options.actionExecuteEnabled?.())]
    },
    call: async (name, args) => {
      if (!DELEGATION_TOOL_NAMES.has(name)) {
        const result = await primitive.call(name, args)
        if (name === 'workspace_list' && options.config && options.entries) return withCapabilitySnapshot(result, options.config(), [...primitive.list(), ...delegationViews(actionMode(), actionEnabled(), options.actionExecuteEnabled?.())], options.entries(), options.agentReadiness?.())
        return result
      }
      if (!enabled()) return errorResult('PROMA Agent 委派未启用', 'AGENT_DISABLED')
      try {
        if (name === 'proma_task_start' || name === 'proma_action_start') {
          if (typeof args.workspace_id !== 'string' || typeof args.instruction !== 'string') return errorResult('需要 workspace_id 与 instruction', 'INVALID_INPUT')
          if (name === 'proma_action_start' && !actionEnabled()) return errorResult('PROMA Agent 动作未启用', 'CAPABILITY_NOT_EXPOSED')
          const kind = name === 'proma_action_start' ? 'action' as const : 'analysis' as const
          const task = queue.start(args.workspace_id, args.instruction, typeof args.target_id === 'string' ? args.target_id : undefined, kind, kind === 'action' && actionMode() === 'approval')
          const result = { task_id: task.id, kind: task.kind ?? 'analysis', status: task.status, approval_required: task.approval?.required === true }
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
        }
        if (typeof args.task_id !== 'string') return errorResult('需要 task_id', 'INVALID_INPUT')
        let task = queue.get(args.task_id)
        if (name === 'proma_task_cancel') { queue.cancel(task.id); task = queue.get(task.id) }
        const result = name === 'proma_task_result'
          ? { task_id: task.id, kind: task.kind ?? 'analysis', status: task.status, summary: task.summary ?? '', changed_files: task.changed_files, warnings: task.warnings, ...(task.errorCode ? { error_code: task.errorCode } : {}) }
          : name === 'proma_task_cancel'
            ? { task_id: task.id, status: task.status }
            : { task_id: task.id, kind: task.kind ?? 'analysis', status: task.status, updated_at: task.updatedAt, approval_required: task.approval?.required === true }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
      } catch (error) {
        const message = error instanceof Error ? error.message : '任务操作失败'
        return errorResult(message, taskErrorCode(error))
      }
    },
  }
}

export function discoveryFingerprint(tools: McpToolHandlers): string {
  return createHash('sha256').update(JSON.stringify({
    manifestVersion: PROMA_MCP_MANIFEST_VERSION,
    instructions: PROMA_MCP_INSTRUCTIONS,
    tools: tools.list().toSorted((a, b) => a.name.localeCompare(b.name)),
  })).digest('hex')
}

/** 旧设置页/IPC 名称兼容；内容已经是完整 Discovery fingerprint。 */
export const toolFingerprint = discoveryFingerprint
