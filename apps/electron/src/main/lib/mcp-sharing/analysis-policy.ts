import type { McpSharingConfig, McpShareRoot } from '@proma/shared'
export function authorizeAnalysisRoot(config: McpSharingConfig, scope: string[], id: string): McpShareRoot & { source: { type: 'agent-workspace'; agentWorkspaceId: string } } {
  const root = config.roots.find((r) => r.id === id && r.enabled && r.permissions.read)
  if (!config.enabled || !config.delegation.enabled || !scope.includes(id) || !root) throw new Error('TASK_SCOPE_DENIED')
  if (root.source.type !== 'agent-workspace') throw new Error('额外文件夹需先创建或关联为 PROMA 项目')
  return { ...root, source: root.source }
}
