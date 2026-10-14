import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentExitPlanService } from './agent-exit-plan-service'

test('Given 已中止的运行 When 请求计划审批 Then 不显示或留下永久等待', async () => {
  const service = new AgentExitPlanService()
  const controller = new AbortController()
  controller.abort()
  let shown = false
  const result = await service.handleExitPlanMode('s', {}, controller.signal, () => { shown = true })
  expect(result.behavior).toBe('deny')
  expect(shown).toBe(false)
  expect(service.getPendingRequests()).toHaveLength(0)
})

test('Given 有效计划 When 等待、取消或同步批准 Then 不默认同意且可靠结算请求', async () => {
  const planDirectory = mkdtempSync(join(tmpdir(), 'proma-plan-wait-'))
  const planFile = join(planDirectory, 'plan.md')
  writeFileSync(planFile, '# 测试计划\n\n只验证审批生命周期。', 'utf8')
  try {
    const service = new AgentExitPlanService()
    const controller = new AbortController()
    let settled = false
    const result = service.handleExitPlanMode('s', { planFile }, controller.signal, () => {}, { planDirectory })
    void result.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(service.getPendingRequests()).toHaveLength(1)
    controller.abort()
    expect((await result).behavior).toBe('deny')
    expect(service.getPendingRequests()).toHaveLength(0)
    const approved = await service.handleExitPlanMode('s', { planFile }, new AbortController().signal, (request) => {
      expect(service.respondToExitPlanMode({ requestId: request.requestId, action: 'approve_bypass' })?.sessionId).toBe('s')
    }, { planDirectory })
    expect(approved.behavior).toBe('allow')
    expect(service.getPendingRequests()).toHaveLength(0)
  } finally {
    unlinkSync(planFile)
    rmdirSync(planDirectory)
  }
})
