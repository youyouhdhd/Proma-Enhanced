import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { getChannelById, resolveChannelRuntimeApiKey } from '../channel-manager'
import { createAgentSession } from '../agent-session-manager'
import { runRegisteredHeadlessAgent, stopRegisteredAgent } from '../agent-headless-runner-registry'
import type { McpToolHandlers } from '../mcp-server/protocol/modern-server'
import { mcpSharingStore } from './store'
import { AnalysisTaskQueue } from './task-queue'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import type { McpRemoteTask } from '@proma/shared'
import { authorizeAnalysisRoot } from './analysis-policy'

export async function validateDelegationModel(channelId?: string, modelId?: string): Promise<void> {
  const channel = channelId ? getChannelById(channelId) : undefined
  if (!channel?.enabled || !modelId || !channel.models.some((m) => m.id === modelId && m.enabled)) throw new Error('请先配置并选择可用的 Agent 渠道与模型')
  if (!await resolveChannelRuntimeApiKey(channel.id)) throw new Error('Agent 渠道尚未完成授权')
}
export function createDelegationQueue(readTools: (workspaceId: string) => McpToolHandlers, allowedRoot: (id: string) => boolean, changed: () => void): AnalysisTaskQueue {
  const taskFile = join(getConfigDir(), 'mcp-analysis-tasks.json')
  const authorize = (id: string) => {
    const config = mcpSharingStore.get()
    const root = authorizeAnalysisRoot(config, allowedRoot(id) ? [id] : [], id)
    if (mcpSharingStore.resolve(root).health.state !== 'available') throw new Error('TASK_ROOT_UNAVAILABLE')
    return { root, config, workspaceId: root.source.agentWorkspaceId }
  }
  return new AnalysisTaskQueue({ run: async (id, instruction, signal, bindSession) => {
    const { config, root, workspaceId } = authorize(id)
    await validateDelegationModel(config.delegation.channelId, config.delegation.modelId)
    const boundPath = mcpSharingStore.resolve(root).entry!.rootPath
    const session = createAgentSession('MCP 只读分析', config.delegation.channelId, workspaceId, config.delegation.modelId, 'project')
    bindSession(session.id)
    const tools = readTools(id)
    const analysisTools: ToolDefinition[] = tools.list().filter((t) => t.annotations.readOnlyHint).map((tool) => ({
      name: 'mcp_analysis_' + tool.name, label: tool.name, description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      execute: async (_callId, args) => {
        const current = authorize(id)
        if (signal.aborted || mcpSharingStore.resolve(current.root).entry?.rootPath !== boundPath) throw new Error('任务已取消或目录已变化')
        const result = await tools.call(tool.name, { ...(args as Record<string, unknown>), workspace_id: id })
        return { content: [{ type: 'text' as const, text: result.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') ?? '' }], details: {} }
      },
    })) as ToolDefinition[]
    return new Promise<string>((resolve, reject) => {
      let failed = false
      const stop = () => { try { stopRegisteredAgent(session.id) } catch { /* 尚未启动 */ } }
      signal.addEventListener('abort', stop, { once: true })
      if (signal.aborted) { signal.removeEventListener('abort', stop); reject(new Error('CANCELLED')); return }
      void runRegisteredHeadlessAgent({ sessionId: session.id, workspaceId, channelId: config.delegation.channelId!, modelId: config.delegation.modelId,
        userMessage: instruction, triggeredBy: 'external', permissionModeOverride: 'plan' }, {
        source: 'delegation', onTitleUpdated: () => undefined, onError: () => { failed = true },
        onComplete: (messages, outcome) => { signal.removeEventListener('abort', stop); if (signal.aborted || outcome?.stoppedByUser) reject(new Error('TASK_CANCELLED')); else if (failed) reject(new Error('ANALYSIS_FAILED')); else resolve(messages?.filter((m) => m.role === 'assistant').at(-1)?.content ?? '分析完成，没有文本结果。') },
      }, { analysisTools }).catch(() => { signal.removeEventListener('abort', stop); reject(new Error('ANALYSIS_FAILED')) })
    })
  } }, authorize, (tasks) => { writeJsonFileAtomic(taskFile, tasks); changed() }, readJsonFileSafe<McpRemoteTask[]>(taskFile) ?? [])
}
