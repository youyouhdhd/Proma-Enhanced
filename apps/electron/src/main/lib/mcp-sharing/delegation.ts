import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { getChannelById, resolveChannelRuntimeApiKey } from '../channel-manager'
import { createAgentSession } from '../agent-session-manager'
import { runRegisteredHeadlessAgent, stopRegisteredAgent } from '../agent-headless-runner-registry'
import type { McpAgentActionMode, McpAgentTarget, McpSharingConfig } from '@proma/shared'
import type { McpToolHandlers } from '../mcp-server/protocol/modern-server'
import { mcpSharingStore } from './store'
import { AnalysisTaskQueue, type AgentRunOptions, type AgentRunResult, type McpTaskKind } from './task-queue'
import { join } from 'node:path'
import { getConfigDir } from '../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../safe-file'
import type { McpRemoteTask, McpAgentAttempt } from '@proma/shared'
import { authorizeAnalysisRoot } from './analysis-policy'
import { TargetRouter } from './target-router'
import { runReadOnlyGit } from '../local-tools/git-tools'

export async function validateDelegationModel(channelId?: string, modelId?: string): Promise<void> {
  const channel = channelId ? getChannelById(channelId) : undefined
  if (!channel?.enabled || !modelId || !channel.models.some((model) => model.id === modelId && model.enabled)) throw new Error('请先配置并选择可用的 Agent 渠道与模型')
  if (!await resolveChannelRuntimeApiKey(channel.id)) throw new Error('Agent 渠道尚未完成授权')
}

export async function validateDelegationTargets(targets: McpAgentTarget[]): Promise<Array<{ target: McpAgentTarget; ready: boolean; detail: string }>> {
  return Promise.all(targets.filter((target) => target.enabled).map(async (target) => {
    try { await validateDelegationModel(target.channelId, target.modelId); return { target, ready: true, detail: 'Ready' } }
    catch { return { target, ready: false, detail: '渠道/模型不可用或尚未授权' } }
  }))
}

interface DelegationToolFactory {
  (workspaceId: string, kind: McpTaskKind): McpToolHandlers
}

function actionPolicy(config: McpSharingConfig): { mode: McpAgentActionMode; write: boolean; execute: boolean } {
  const action = config.delegation.action
  return {
    mode: action?.mode ?? 'analysis',
    write: action?.mode !== 'analysis' && action?.write === true,
    execute: action?.mode !== 'analysis' && action?.execute === true,
  }
}

function assertTaskAuthorization(config: McpSharingConfig, scope: string[], id: string, kind: McpTaskKind): ReturnType<typeof authorizeAnalysisRoot> {
  const root = authorizeAnalysisRoot(config, scope, id)
  if (kind === 'action') {
    const action = actionPolicy(config)
    if (action.mode === 'analysis' || (!action.write && !action.execute)) throw new Error('AGENT_ACTION_DISABLED')
    if (!(action.write && root.permissions.write || action.execute && root.permissions.shell)) throw new Error('PERMISSION_DENIED')
  }
  return root
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.filter((content) => content.type === 'text' && typeof content.text === 'string').map((content) => content.text!).join('\n') ?? ''
}

function gitChangedFiles(rootPath: string): string[] {
  const result = runReadOnlyGit(rootPath, ['status', '--porcelain=v1'])
  if (result.status !== 0) return []
  return result.stdout.split(/\r?\n/).filter((line) => line.length > 3).map((line) => {
    const path = line.slice(3).trim()
    const rename = path.lastIndexOf(' -> ')
    return rename >= 0 ? path.slice(rename + 4) : path
  }).filter(Boolean).slice(0, 200)
}

export function createDelegationQueue(toolsFor: DelegationToolFactory, allowedRoot: (id: string) => boolean, changed: () => void): AnalysisTaskQueue {
  const router = new TargetRouter()
  const taskFile = join(getConfigDir(), 'mcp-analysis-tasks.json')
  const authorize = (id: string, kind: McpTaskKind = 'analysis') => {
    const config = mcpSharingStore.get()
    const root = assertTaskAuthorization(config, allowedRoot(id) ? [id] : [], id, kind)
    const resolved = mcpSharingStore.resolve(root)
    if (resolved.health.state !== 'available' || !resolved.entry) throw new Error('TASK_ROOT_UNAVAILABLE')
    return { root, config, entry: resolved.entry, workspaceId: root.source.agentWorkspaceId }
  }
  return new AnalysisTaskQueue({
    run: async (id, instruction, signal, bindSession, targetId, audit, options: AgentRunOptions = { kind: 'analysis', approved: true }): Promise<string | AgentRunResult> => {
      const kind = options.kind
      const initial = authorize(id, kind)
      const boundPath = initial.entry.rootPath
      const validated = await validateDelegationTargets(initial.config.delegation.targets)
      return router.run(initial.config.delegation, validated.filter((item) => item.ready).map((item) => item.target), targetId, signal, async (target) => {
        const current = authorize(id, kind)
        if (signal.aborted || mcpSharingStore.resolve(current.root).entry?.rootPath !== boundPath) throw new Error('TASK_CANCELLED')
        const planning = kind === 'action' && !options.approved
        const session = createAgentSession(planning ? 'MCP Agent 动作计划' : kind === 'action' ? 'MCP Agent 动作执行' : 'MCP 只读分析', target.channelId, current.workspaceId, target.modelId, 'project')
        bindSession(session.id)
        const tools = toolsFor(id, planning ? 'analysis' : kind)
        const toolAllowed = (name: string): boolean => name !== 'write_file' && name !== 'edit_file' && name !== 'shell_execute'
          || name === 'write_file' && current.entry.permissions.write
          || name === 'edit_file' && current.entry.permissions.write
          || name === 'shell_execute' && current.entry.permissions.shell
        const changedFiles = new Set<string>()
        const initialGitChanges = kind === 'action' && !planning ? new Set(gitChangedFiles(current.entry.rootPath)) : new Set<string>()
        const warnings: string[] = []
        const agentTools: ToolDefinition[] = tools.list().filter((tool) => (planning ? tool.annotations.readOnlyHint : toolAllowed(tool.name))).map((tool) => ({
          name: (planning ? 'mcp_analysis_' : 'mcp_action_') + tool.name,
          label: tool.title ?? tool.name,
          description: tool.description,
          parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
          execute: async (_callId, args) => {
            const live = authorize(id, kind)
            if (signal.aborted || mcpSharingStore.resolve(live.root).entry?.rootPath !== boundPath) throw new Error('任务已取消或目录已变化')
            const input = args as Record<string, unknown>
            const result = await tools.call(tool.name, { ...input, workspace_id: id })
            if (result.isError) throw new Error(textOf(result) || '工具调用失败')
            if (!result.isError && !planning) {
              if ((tool.name === 'write_file' || tool.name === 'edit_file') && typeof input.path === 'string') changedFiles.add(input.path)
              if (tool.name === 'shell_execute') warnings.push('SHELL_CHANGES_NOT_FULLY_TRACKED')
            }
            return { content: [{ type: 'text' as const, text: textOf(result) }], details: {} }
          },
        })) as ToolDefinition[]
        return new Promise<AgentRunResult>((resolve, reject) => {
          let failed = false
          const stop = () => { try { stopRegisteredAgent(session.id) } catch { /* 尚未启动 */ } }
          signal.addEventListener('abort', stop, { once: true })
          if (signal.aborted) { signal.removeEventListener('abort', stop); reject(new Error('CANCELLED')); return }
          void runRegisteredHeadlessAgent({
            sessionId: session.id,
            workspaceId: current.workspaceId,
            channelId: target.channelId,
            modelId: target.modelId,
            userMessage: instruction,
            triggeredBy: 'external',
            permissionModeOverride: planning ? 'plan' : 'bypassPermissions',
          }, {
            source: 'delegation',
            onTitleUpdated: () => undefined,
            onError: () => { failed = true },
            onComplete: (messages, outcome) => {
              signal.removeEventListener('abort', stop)
              if (signal.aborted || outcome?.stoppedByUser) reject(new Error('TASK_CANCELLED'))
              else if (failed) reject(new Error(kind === 'action' ? 'ACTION_FAILED' : 'ANALYSIS_FAILED'))
              else {
                const summary = messages?.filter((message) => message.role === 'assistant').at(-1)?.content ?? (planning ? '动作计划已生成，请在 PROMA 本地审批。' : '分析完成，没有文本结果。')
                const currentGitChanges = kind === 'action' ? gitChangedFiles(current.entry.rootPath) : []
                const trackedChanges = kind === 'action' ? [...new Set([...changedFiles, ...currentGitChanges.filter((path) => !initialGitChanges.has(path))])] : []
                resolve({ summary, waitingApproval: planning, changedFiles: trackedChanges, warnings })
              }
            },
          }, planning ? { analysisTools: agentTools } : { actionTools: agentTools }).catch(() => { signal.removeEventListener('abort', stop); reject(new Error(kind === 'action' ? 'ACTION_FAILED' : 'ANALYSIS_FAILED')) })
        })
      }, audit)
    },
  }, authorize, (tasks) => { writeJsonFileAtomic(taskFile, tasks) ; changed() }, readJsonFileSafe<McpRemoteTask[]>(taskFile) ?? [], () => mcpSharingStore.get().delegation)
}
