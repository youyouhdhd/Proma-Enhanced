import { describe, expect, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS } from '@proma/shared'
import { getParentRequestTimeoutMs } from './agent-runtime-request-timeout'

describe('本地用户交互的运行时等待', () => {
  test('Given 问答/权限/计划审批的授权阶段 When 用户尚未回复 Then 不自动超时', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL)).toBeNull()
  })

  test('Given 其他RPC能力 When 等待主进程响应 Then 保留故障检测超时', () => {
    for (const method of Object.values(AGENT_RUNTIME_METHODS).filter((value) => value !== AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL)) {
      expect(getParentRequestTimeoutMs(method)).toBe(120_000)
    }
    expect(getParentRequestTimeoutMs('unknown-method')).toBe(120_000)
  })
})
