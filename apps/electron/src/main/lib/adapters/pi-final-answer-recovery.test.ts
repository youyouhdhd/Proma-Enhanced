import { describe, expect, test } from 'bun:test'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { Message } from '@earendil-works/pi-ai'
import { constrainRecoveryPayload, recoverFinalAnswer, withoutRecoveryTools } from './pi-final-answer-recovery'
import { resolvePiModelDefaults } from './pi-model-registry'
import { resolveReasoningProfile } from '@proma/shared'
import { isTransientNetworkError, isMalformedResponseError } from '../error-patterns'

describe('补答请求边界', () => {
  test('Given 历史多次注册工具 When 创建补答副本 Then 全部移除且原对象不变', () => {
    const messages = [{ role: 'system', content: '', toolsAdded: [{ name: 'danger' }], toolsRemoved: ['old'] }, { role: 'system', content: '上下文', toolsAdded: [{ name: 'danger2' }] }] as unknown as Message[]
    const before = JSON.stringify(messages)
    expect(JSON.stringify(withoutRecoveryTools(messages))).not.toMatch(/toolsAdded|toolsRemoved/)
    expect(JSON.stringify(messages)).toBe(before)
  })
  test('Given 上层hook重新加入工具及高思考预算 When 最终约束 Then 无工具且输出有上限', () => {
    expect(constrainRecoveryPayload({ model: 'DeepSeek-V4.1-Flash', tools: [{}], tool_choice: 'any', max_tokens: 100000, thinking: { type: 'enabled', budget_tokens: 90000 } }, 'anthropic-messages', true)).toMatchObject({ max_tokens: 8192, thinking: { type: 'disabled' } })
    const body = constrainRecoveryPayload({ tools: [{}], tool_choice: 'auto', max_output_tokens: 100000, reasoning: { effort: 'high' } }, 'openai-responses', false)
    expect(body).toEqual({ max_output_tokens: 8192, reasoning: { effort: 'low' } })
    expect(constrainRecoveryPayload({ max_completion_tokens: 100000 }, 'openai-completions', false)).toEqual({ max_completion_tokens: 8192 })
    expect(() => constrainRecoveryPayload('invalid', 'anthropic-messages', false)).toThrow()
  })
  test('Given 卡住的上下文转换 When 截止或预取消 Then 不调用provider且及时退出', async () => {
    const controller = new AbortController()
    const session = { model: { id: 'fixture' }, agent: { state: { messages: [] }, transformContext: () => new Promise(() => {}) } } as unknown as AgentSession
    expect((await recoverFinalAnswer(session, controller, 10)).info.status).toBe('missing')
    expect(controller.signal.aborted).toBe(true)
    expect((await recoverFinalAnswer(session, controller, 10)).info.status).toBe('missing')
  })
  test('Given 上下文没有安全输出空间 When 补答 Then 不发provider请求', async () => {
    const session = { model: { id: 'fixture', api: 'anthropic-messages', maxTokens: 8192 }, getContextUsage: () => ({ tokens: 9000, contextWindow: 10000 }), agent: { state: { messages: [] }, convertToLlm: () => [] } } as unknown as AgentSession
    expect((await recoverFinalAnswer(session, new AbortController())).info.status).toBe('missing')
  })
  test('Given 协议校验错误 When 分类 Then 不走瞬时或坏JSON自动重试', () => {
    expect(isTransientNetworkError('provider_stream_protocol_error: invalid_block_delta index=1')).toBe(false)
    expect(isMalformedResponseError('provider_stream_protocol_error: invalid_json')).toBe(false)
  })
})

describe('V4.1显式兼容范围', () => {
  for (const id of ['DeepSeek-V4.1-Flash', 'deepseek-v4-1-flash', 'deepseek-v4-1-flash-260910']) {
    test(`Given ${id} When 解析 Then 支持明确档位`, () => {
      expect(resolveReasoningProfile({ modelId: id, transport: 'anthropic-messages' })).toMatchObject({ id: 'deepseek-v4.1-flash', levels: ['off', 'low', 'high', 'max'] })
    })
  }
  test('Given 方舟V4.1和其他组合 When 注册 Then 空签名只在白名单启用', async () => {
    for (const [provider, model, allowed] of [['ark-coding-plan', 'DeepSeek-V4.1-Flash', true], ['deepseek', 'DeepSeek-V4.1-Flash', false], ['ark-coding-plan', 'claude-sonnet-4', false], ['ark-coding-plan', 'deepseek-v4.1-flash-unknown', false]] as const) {
      const defaults = await resolvePiModelDefaults({ provider, model, sessionId: 'fixture', prompt: '', cwd: '.', apiKey: 'fixture', systemPrompt: '', permissionMode: 'bypassPermissions', piAgentDir: '.', piSessionDir: '.' })
      expect(Boolean(defaults.compat && 'allowEmptySignature' in defaults.compat && defaults.compat.allowEmptySignature === true)).toBe(allowed)
    }
  })
})
