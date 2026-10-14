import { describe, expect, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS } from '@proma/shared'
import { ASK_USER_QUESTION_TIMEOUT_MS, getParentRequestTimeoutMs } from './agent-runtime-request-timeout'

describe('终端用户接管的运行时等待', () => {
  test('Given 明确绑定终端的问答 When 用户进行长时间操作 Then 不因普通问答超时中断', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL,
      { toolName: 'AskUserQuestion', input: { terminalId: 'terminal-1' } })).toBeNull()
  })

  test('Given 普通问答或非法终端标识 When 选择超时 Then 保持原 15 分钟边界', () => {
    for (const input of [undefined, {}, { terminalId: '' }, { terminalId: ' ' }, { terminalId: 42 }]) {
      expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL,
        { toolName: 'AskUserQuestion', input })).toBe(ASK_USER_QUESTION_TIMEOUT_MS)
    }
  })

  test('Given 其他能力调用 When 附带 terminalId Then 不放宽原故障超时', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL,
      { toolName: 'TerminalRead', input: { terminalId: 'terminal-1' } })).toBe(120_000)
    expect(getParentRequestTimeoutMs('other-method', { toolName: 'AskUserQuestion', input: { terminalId: 'terminal-1' } })).toBe(120_000)
  })
})
