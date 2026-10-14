import type { AgentFinalAnswerInfo, SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@proma/shared'
import { normalizeThinkTagsInContentBlocks } from './thinking-tags'

export const MISSING_FINAL_ANSWER_MESSAGE = '模型未生成最终答复，执行过程已保留。'

/** 调用方提供当前回合；仅最终主线模型消息能成为结论。 */
export function inspectFinalAnswer(messages: readonly SDKMessage[]): AgentFinalAnswerInfo {
  const last = [...messages].reverse().find((m): m is SDKAssistantMessage =>
    m.type === 'assistant' && !m.parent_tool_use_id && !m.isReplay && !('_partial' in m && m._partial))
  if (!last) return { status: 'missing', recoveryAttempted: false, reason: 'empty' }
  if (last.error || ['error', 'aborted', 'length', 'max_tokens'].includes(last.message.stop_reason ?? '')) {
    return { status: 'not_required', recoveryAttempted: false }
  }
  const blocks = normalizeThinkTagsInContentBlocks(last.message.content, { contentFormat: last.message.content_format })
  const hasTools = blocks.some(b => b.type === 'tool_use')
  if (!hasTools && blocks.some(b => b.type === 'text' && typeof b.text === 'string' && b.text.trim())) return { status: 'present', recoveryAttempted: false }
  return { status: 'missing', recoveryAttempted: false, reason: hasTools ? 'tool_only' : blocks.some(b => b.type === 'thinking') ? 'thinking_only' : 'empty' }
}

/** 旧回合不重写磁盘，只派生状态；错误/压缩/后台任务不重复显示缺正文。 */
export function getTurnFinalAnswer(messages: readonly SDKMessage[]): AgentFinalAnswerInfo {
  const result = [...messages].reverse().find((m): m is SDKResultMessage => m.type === 'result')
  if (result?.final_answer) return result.final_answer
  if (result && (result.subtype !== 'success' || result.isSyntheticCompactionResult || result.background_tasks?.some(task => task.status === 'running' || task.status === 'pending'))) {
    return { status: 'not_required', recoveryAttempted: false }
  }
  if (!messages.some(m => m.type === 'assistant')) return { status: 'not_required', recoveryAttempted: false }
  return inspectFinalAnswer(messages)
}
