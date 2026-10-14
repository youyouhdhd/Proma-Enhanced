import { describe, expect, test } from 'bun:test'
import { AGENT_IPC_CHANNELS } from '@proma/shared'
import { sendAgentStreamComplete } from './agent-completion-payload'

describe('最终答复状态跨IPC传递', () => {
  test('Given 补答失败 When 完成事件发送 Then 保留失败、代际和补答信息', () => {
    let received: unknown
    sendAgentStreamComplete({ send(channel, payload) { expect(channel).toBe(AGENT_IPC_CHANNELS.STREAM_COMPLETE); received = payload } }, { sessionId: 'fixture', runGeneration: 3 }, {
      stoppedByUser: false, resultSubtype: 'error_during_execution', resultErrors: ['未生成最终答复'], final_answer: { status: 'missing', recoveryAttempted: true, reason: 'thinking_only' },
    })
    expect(received).toMatchObject({ sessionId: 'fixture', runGeneration: 3, stoppedByUser: false, resultSubtype: 'error_during_execution', resultErrors: ['未生成最终答复'], final_answer: { status: 'missing', recoveryAttempted: true } })
  })
})
