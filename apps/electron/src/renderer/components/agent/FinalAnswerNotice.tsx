import type { SDKAssistantMessage, SDKMessage } from '@proma/shared'
import { getTurnFinalAnswer } from '@proma/session-core'

interface FinalAnswerNoticeProps {
  messages: readonly SDKMessage[]
  isStreaming?: boolean
  stoppedByUser?: boolean
  hasError?: boolean
}

/** 状态始终位于折叠过程外，历史浏览不触发模型或工具。 */
export function FinalAnswerNotice({ messages, isStreaming, stoppedByUser, hasError }: FinalAnswerNoticeProps): React.ReactElement | null {
  if (isStreaming) {
    return messages.some(m => m.type === 'system' && m.subtype === 'finalizing')
      ? <p role="status" aria-live="polite" className="text-sm text-muted-foreground">正在整理最终答复，最多等待 60 秒…</p> : null
  }
  if (stoppedByUser || hasError) return null
  const missing = getTurnFinalAnswer(messages).status === 'missing'
  const unclosed = messages.some(m => {
    if (m.type !== 'assistant') return false
    const assistant = m as SDKAssistantMessage
    if (assistant.message.content_format === 'structured' || assistant.message.content.some(b => b.type === 'thinking')) return false
    const text = assistant.message.content.flatMap(b => b.type === 'text' && 'text' in b && typeof b.text === 'string' ? [b.text] : []).join('')
    return /^\s*<think>/i.test(text) && !/<\/think>/i.test(text)
  })
  if (!missing && !unclosed) return null
  return <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
    {missing ? '该轮已结束，但没有最终正文。展开执行过程查看已有结果；需要继续时可在输入框补充说明。' : '该消息的思考标签未闭合，已按原文保留。'}
  </p>
}
