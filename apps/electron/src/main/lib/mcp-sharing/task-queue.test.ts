import { it, expect } from 'bun:test'
import { AnalysisTaskQueue } from './task-queue'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
it('Given 状态保存失败 When 连续分析任务完成 Then 队列仍释放执行槽位', async () => {
  let calls = 0
  const queue = new AnalysisTaskQueue({ run: async () => { calls++; return 'ok' } }, () => undefined, () => { throw new Error('disk full') })
  const first = queue.start('ws_agent', 'first')
  const second = queue.start('ws_agent', 'second')
  await tick()
  expect(calls).toBe(2)
  expect(queue.get(first.id).status).toBe('completed')
  expect(queue.get(second.id).status).toBe('completed')
})
it('Given 远程分析请求 When 排队/重复/取消/撤权 Then 单并发、最多3等待且不泄露 instruction', async () => {
  const running: Array<{ done: (value: string) => void; signal: AbortSignal }> = []
  let authorized = true
  const queue = new AnalysisTaskQueue({ run: (_id, _text, signal, bind) => { bind('session-fixture'); return new Promise<string>((done) => { running.push({ done, signal }) }) } }, (id) => { if (!authorized || id !== 'ws_agent') throw new Error('DENY') })
  const first = queue.start('ws_agent', 'private-instruction')
  expect(first.status).toBe('queued')
  expect(queue.start('ws_agent', 'private-instruction').id).toBe(first.id)
  await tick()
  expect(running).toHaveLength(1)
  const second = queue.start('ws_agent', 'second')
  queue.start('ws_agent', 'third'); queue.start('ws_agent', 'fourth')
  expect(() => queue.start('ws_agent', 'fifth')).toThrow('TASK_RATE_LIMIT')
  expect(JSON.stringify(queue.snapshot())).not.toContain('private-instruction')
  queue.cancel(second.id)
  running[0]!.done('completed summary'); await tick()
  expect(queue.get(first.id).status).toBe('completed')
  expect(queue.start('ws_agent', 'private-instruction').id).toBe(first.id)
  expect(running).toHaveLength(2)
  authorized = false; queue.reconcile()
  expect(running[1]!.signal.aborted).toBe(true)
  running[1]!.done('cancelled'); await tick()
  expect(queue.snapshot().filter((t) => t.status === 'running' || t.status === 'queued')).toHaveLength(0)
  expect(() => queue.get(first.id)).toThrow('DENY')
})
it('Given 持久化中的运行任务 When 重启恢复 Then 标记中断且不重新消耗模型', () => {
  let calls = 0
  const queue = new AnalysisTaskQueue({ run: async () => { calls++; return '' } }, () => undefined, () => undefined,
    [{ id: 'pt_' + 'a'.repeat(32), workspaceId: 'ws_agent', createdAt: 1, updatedAt: 1, status: 'running', changed_files: [], warnings: [] }])
  expect(queue.snapshot()[0]?.status).toBe('failed')
  expect(calls).toBe(0)
})

it('Given Agent 动作需要审批 When 计划完成并在本地批准 Then 才进入动作执行', async () => {
  const calls: Array<{ approved: boolean }> = []
  const queue = new AnalysisTaskQueue({
    run: async (_id, _instruction, _signal, _bind, _target, _audit, options) => {
      calls.push({ approved: options?.approved === true })
      return options?.approved ? { summary: '动作完成', changedFiles: ['README.md'] } : { summary: '计划已生成', waitingApproval: true }
    },
  }, () => undefined)
  const task = queue.start('ws_agent', 'modify', undefined, 'action', true)
  await tick()
  expect(queue.get(task.id).status).toBe('waiting_approval')
  expect(calls).toEqual([{ approved: false }])
  queue.approve(task.id)
  await tick()
  expect(queue.get(task.id)).toMatchObject({ status: 'completed', changed_files: ['README.md'], approval: { decision: 'approved' } })
  expect(calls).toEqual([{ approved: false }, { approved: true }])
})

it('Given maxQueued=0 When 一个动作等待本地审批 Then 不允许继续堆积等待任务', async () => {
  const queue = new AnalysisTaskQueue({ run: async () => ({ summary: '待审批计划', waitingApproval: true }) }, () => undefined, () => undefined, [], () => ({ maxConcurrent: 1, maxQueued: 0 }))
  const first = queue.start('ws_agent', 'first action', undefined, 'action', true)
  await tick()
  expect(queue.get(first.id).status).toBe('waiting_approval')
  expect(() => queue.start('ws_agent', 'second action', undefined, 'action', true)).toThrow('BUSY')
})
