import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKContentBlock, SDKMessage } from '@proma/shared'
import { inspectFinalAnswer, getTurnFinalAnswer } from './final-answer'
import { normalizeThinkTagsInContentBlocks } from './thinking-tags'
import { groupIntoTurns } from './group'
import { toTranscript } from './transcript'
import { renderTranscriptMarkdown } from './render-markdown'

function assistant(content: SDKContentBlock[]): SDKAssistantMessage {
  return { type: 'assistant', parent_tool_use_id: null, message: { content, content_format: 'structured', stop_reason: 'stop' } }
}
describe('最终正文契约', () => {
  test('Given 缺正文旧回合 When CLI/导出 Then 可见状态且不导出思考为正文', () => {
    const messages: SDKMessage[] = [assistant([{ type: 'thinking', thinking: '内部过程' }]), { type: 'result', subtype: 'success', usage: { input_tokens: 0, output_tokens: 0 } }]
    const turns = toTranscript(groupIntoTurns(messages))
    expect(turns[0]?.preview).toContain('未生成最终答复')
    expect(renderTranscriptMarkdown(turns)).toContain('未生成最终答复')
    expect(renderTranscriptMarkdown(turns)).not.toContain('内部过程')
  })
  test('Given 普通正文 When 判断 Then 有最终答复', () => {
    expect(inspectFinalAnswer([assistant([{ type: 'text', text: '验证通过' }])]).status).toBe('present')
  })
  test('Given 过程有文字但最终只含思考 When 判断 Then 缺正文', () => {
    expect(inspectFinalAnswer([assistant([{ type: 'text', text: '正在执行' }]), assistant([{ type: 'thinking', thinking: '结束' }])])).toMatchObject({ status: 'missing', reason: 'thinking_only' })
  })
  test('Given 最终只有工具或空白 When 判断 Then 不能作为结论', () => {
    expect(inspectFinalAnswer([assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])]).reason).toBe('tool_only')
    expect(inspectFinalAnswer([assistant([{ type: 'text', text: ' ' }])]).reason).toBe('empty')
  })
  test('Given 子代理/partial/replay有答案 When 主线没有答案 Then 不能用它们通过', () => {
    const child = assistant([{ type: 'text', text: '子任务结论' }]); child.parent_tool_use_id = 'parent'
    const replay = { ...assistant([{ type: 'text', text: '旧答复' }]), isReplay: true }
    expect(inspectFinalAnswer([child, replay]).status).toBe('missing')
  })
  test('Given 历史success只有思考 When 派生状态 Then 显示缺正文但不改原记录', () => {
    const messages: SDKMessage[] = [assistant([{ type: 'thinking', thinking: '结论也在此' }]), { type: 'result', subtype: 'success', usage: { input_tokens: 0, output_tokens: 0 } }]
    const before = JSON.stringify(messages)
    expect(getTurnFinalAnswer(messages).status).toBe('missing')
    expect(JSON.stringify(messages)).toBe(before)
  })
  test('Given 错误/压缩/取消 When 判断 Then 不覆盖原错误', () => {
    const failed = assistant([]); failed.error = { message: '故障' }
    expect(inspectFinalAnswer([failed]).status).toBe('not_required')
    expect(getTurnFinalAnswer([{ type: 'result', subtype: 'success', isSyntheticCompactionResult: true, usage: { input_tokens: 0, output_tokens: 0 } }]).status).toBe('not_required')
  })
})
describe('标签兼容保持正文可见', () => {
  test.each(['正文中的<think>示例', '`<think>`\n结论', '```xml\n<think>\n```\n结论', '> <think>\n结论', '<think>未闭合，结论也在此'])('Given 字面或未闭合标签 %s When 完成显示 Then 保留正文', text => {
    expect(normalizeThinkTagsInContentBlocks([{ type: 'text', text }])).toEqual([{ type: 'text', text }])
  })
  test('Given 原生结构化正文 When 包含完整标签 Then 仍是正文', () => {
    expect(normalizeThinkTagsInContentBlocks([{ type: 'text', text: '<think>例子</think>正文' }], { contentFormat: 'structured' })[0]?.type).toBe('text')
  })
  test('Given 历史前导标签跨文本块 When 规范化 Then 保留闭合后正文', () => {
    expect(normalizeThinkTagsInContentBlocks([{ type: 'text', text: '<think>思考</thi' }, { type: 'text', text: 'nk>答案' }]).map(b => b.type)).toEqual(['thinking', 'text'])
  })
})
