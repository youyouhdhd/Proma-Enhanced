import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKMessage } from '@proma/shared'
import { FinalAnswerNotice } from './FinalAnswerNotice'

const messages: SDKMessage[] = [{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: '结论在此' }] } }]
describe('过程外的最终答复状态', () => {
  test('Given 旧thinking-only回合 When 渲染 Then 常驻提示及继续说明可见', () => {
    const html = renderToStaticMarkup(<FinalAnswerNotice messages={messages} />)
    expect(html).toContain('没有最终正文'); expect(html).toContain('role="status"')
  })
  test('Given 补答中 When 渲染 Then 显示60秒上限及无障碍播报', () => {
    const html = renderToStaticMarkup(<FinalAnswerNotice messages={[...messages, { type: 'system', subtype: 'finalizing' }]} isStreaming />)
    expect(html).toContain('60 秒'); expect(html).toContain('aria-live="polite"')
  })
  test('Given 已取消/已有真实错误 When 渲染 Then 不叠加缺正文提示', () => {
    expect(renderToStaticMarkup(<FinalAnswerNotice messages={messages} stoppedByUser />)).toBe('')
    expect(renderToStaticMarkup(<FinalAnswerNotice messages={messages} hasError />)).toBe('')
  })
})
