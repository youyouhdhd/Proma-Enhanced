import type { McpSharingConfig } from '@proma/shared'
import type { LocalToolRisk } from '../local-tools/types'
import type { WorkspaceDirectoryEntry } from '../mcp-server/multi-workspace'

export function canExposeTool(risk: LocalToolRisk, config: McpSharingConfig): boolean {
  // Approval 不得静默退化为 Direct；审批执行器接入前拒绝执行。
  return config.enabled && config.policy[risk] === 'direct'
}
export function canCallTool(risk: LocalToolRisk, root: WorkspaceDirectoryEntry, config: McpSharingConfig): boolean {
  return canExposeTool(risk, config) && root.enabled && root.permissions[risk === 'execute' ? 'shell' : risk]
}

/** 只保留频率计数和活动信号，不记录命令、文件内容或请求参数。 */
export class RemoteExecutionGuard {
  private active = new Map<AbortController, { risk: 'write' | 'execute'; workspaceId: string }>()
  private starts = { write: [] as number[], execute: [] as number[] }
  acquire(risk: 'write' | 'execute', workspaceId: string, config: McpSharingConfig): { signal: AbortSignal; release(): void } {
    const now = Date.now(); const starts = this.starts[risk]
    while (starts.length && starts[0]! < now - 60000) starts.shift()
    const count = [...this.active.values()].filter((entry) => entry.risk === risk).length
    if (count >= (risk === 'execute' ? 1 : config.limits.writeConcurrent) || starts.length >= (risk === 'execute' ? config.limits.shellCallsPerMinute : config.limits.writeCallsPerMinute)) throw new Error('REMOTE_RATE_LIMIT')
    const controller = new AbortController(); this.active.set(controller, { risk, workspaceId }); starts.push(now)
    return { signal: controller.signal, release: () => { this.active.delete(controller) } }
  }
  revoke(): void { for (const controller of this.active.keys()) controller.abort() }
  reconcile(entries: WorkspaceDirectoryEntry[], config: McpSharingConfig): void {
    for (const [controller, task] of this.active) {
      const root = entries.find((entry) => entry.id === task.workspaceId)
      if (!root || !canCallTool(task.risk, root, config)) controller.abort()
    }
  }
}
