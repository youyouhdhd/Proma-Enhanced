import { AGENT_RUNTIME_METHODS } from '@proma/shared'

const DEFAULT_PARENT_REQUEST_TIMEOUT_MS = 120_000
// AskUserQuestion 属于用户主导的自由文本交互；两分钟不足以完成输入。
export const ASK_USER_QUESTION_TIMEOUT_MS = 15 * 60_000

/**
 * Utility Process 请求主进程的等待时间。
 * 仅 AskUserQuestion 延长，避免放宽其他跨进程能力调用的故障检测。
 */
export function getParentRequestTimeoutMs(method: string, payload: unknown): number | null {
  const request = payload as { toolName?: unknown; input?: { terminalId?: unknown } } | null
  if (
    method === AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL
    && request?.toolName === 'AskUserQuestion'
  ) {
    // 用户接管终端可能包含长时间安装/登录，只由回复、取消或终端消失解除。
    if (typeof request.input?.terminalId === 'string' && request.input.terminalId.trim()) return null
    return ASK_USER_QUESTION_TIMEOUT_MS
  }
  return DEFAULT_PARENT_REQUEST_TIMEOUT_MS
}
