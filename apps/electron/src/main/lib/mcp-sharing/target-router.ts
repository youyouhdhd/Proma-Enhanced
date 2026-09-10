import type { McpAgentTarget, McpAgentAttempt, McpDelegationConfig } from '@proma/shared'

export class TargetRouter {
  private cursor = 0
  async run<T>(config: McpDelegationConfig, ready: McpAgentTarget[], manual: string | undefined, signal: AbortSignal,
    execute: (target: McpAgentTarget) => Promise<T>, audit: (attempt: McpAgentAttempt) => void = () => undefined): Promise<T> {
    let candidates = ready.filter((target) => target.enabled).toSorted((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    if (config.strategy === 'manual') {
      if (!manual) throw new Error('AGENT_TARGET_REQUIRED')
      candidates = candidates.filter((target) => target.id === manual)
    } else if (manual) throw new Error('AGENT_MANUAL_STRATEGY_REQUIRED')
    if (!candidates.length) throw new Error('AGENT_NO_READY_TARGET')
    if (config.strategy === 'round-robin') candidates = [candidates[this.cursor++ % candidates.length]!]
    for (const target of candidates) {
      if (signal.aborted) throw new Error('TASK_CANCELLED')
      const startedAt = Date.now()
      try {
        const result = await execute(target)
        if (signal.aborted) throw new Error('TASK_CANCELLED')
        audit({ targetId: target.id, startedAt, endedAt: Date.now(), resultType: 'completed' })
        return result
      } catch (error) {
        const cancelled = signal.aborted || error instanceof Error && error.message === 'TASK_CANCELLED'
        audit({ targetId: target.id, startedAt, endedAt: Date.now(), resultType: cancelled ? 'cancelled' : 'failed' })
        if (cancelled) throw new Error('TASK_CANCELLED')
      }
    }
    throw new Error('AGENT_ALL_TARGETS_FAILED')
  }
}
