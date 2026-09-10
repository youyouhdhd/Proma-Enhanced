import { it, expect } from 'bun:test'
import type { McpDelegationConfig, McpAgentAttempt } from '@proma/shared'
import { TargetRouter } from './target-router'

it('Given 多渠道目标 When fallback/轮询/manual Then 正确选路并只记录安全尝试元数据', async () => {
  const config: McpDelegationConfig = { enabled: true, strategy: 'fallback', maxConcurrent: 1, maxQueued: 3, targets: ['a', 'b'].map((id, priority) => ({ id, channelId: id, modelId: id, enabled: true, priority })) }
  const router = new TargetRouter(); const signal = new AbortController().signal; const attempts: McpAgentAttempt[] = []
  expect(await router.run(config, config.targets, undefined, signal, async (target) => { if (target.id === 'a') throw new Error('private error'); return target.id }, (attempt) => attempts.push(attempt))).toBe('b')
  expect(attempts.map((attempt) => attempt.resultType)).toEqual(['failed', 'completed'])
  expect(JSON.stringify(attempts)).not.toContain('private')
  const round = { ...config, strategy: 'round-robin' as const }
  expect(await router.run(round, config.targets, undefined, signal, async (target) => target.id)).toBe('a')
  expect(await router.run(round, config.targets, undefined, signal, async (target) => target.id)).toBe('b')
  expect(await router.run({ ...config, strategy: 'manual' }, config.targets, 'b', signal, async (target) => target.id)).toBe('b')
  await expect(router.run({ ...config, strategy: 'manual' }, config.targets, undefined, signal, async () => '')).rejects.toThrow('AGENT_TARGET_REQUIRED')
  let cancelledCalls = 0
  await expect(router.run(config, config.targets, undefined, signal, async () => { cancelledCalls++; throw new Error('TASK_CANCELLED') })).rejects.toThrow('TASK_CANCELLED')
  expect(cancelledCalls).toBe(1)
})
