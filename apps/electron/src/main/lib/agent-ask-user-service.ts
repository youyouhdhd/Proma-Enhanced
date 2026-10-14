/**
 * Agent AskUserQuestion 交互式问答服务
 *
 * 核心职责：
 * - 拦截 AskUserQuestion 工具调用
 * - 解析问题列表，发送到渲染进程展示交互 UI
 * - 等待用户回答，通过 updatedInput 注入 answers 字段
 * - 管理 pending 请求生命周期
 *
 * 复用权限系统的 Promise + Map 异步等待模式。
 */

import { randomUUID } from 'node:crypto'
import type {
  AskUserRequest,
  AskUserQuestion,
  AskUserQuestionOption,
  AskUserResponse,
} from '@proma/shared'

/** canUseTool 返回的权限结果 */
type PermissionResult = {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
} | {
  behavior: 'deny'
  message: string
}

/** 待处理的 AskUser 请求 */
interface PendingAskUser {
  resolve: (result: PermissionResult) => void
  request: AskUserRequest
  onResolved?: (requestId: string) => void
}

/**
 * Agent AskUserQuestion 交互式问答服务
 *
 * 单例模式，管理所有会话的 AskUser 请求。
 */
export class AgentAskUserService {
  /** 待处理的 AskUser 请求 Map（requestId → PendingAskUser） */
  private pendingRequests = new Map<string, PendingAskUser>()

  /**
   * 处理 AskUserQuestion 工具调用
   *
   * 解析问题列表，发送到渲染进程，阻塞等待用户回答，
   * 回答后通过 updatedInput 注入 answers 字段。
   */
  handleAskUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    sendToRenderer: (request: AskUserRequest) => void,
    terminal?: AskUserRequest['terminal'],
    onResolved?: (requestId: string) => void,
  ): Promise<PermissionResult> {
    const questions = this.parseQuestions(input)
    if (terminal && (questions.length !== 1 || !questions[0]?.question.trim() || questions[0].question.length > 4_000)) {
      throw new Error('终端接管需要一条非空操作说明，最多 4000 字符')
    }
    if (terminal) questions[0]!.options = [{ label: '已完成，继续' }, { label: '遇到问题' }]
    if (signal.aborted) return Promise.resolve({ behavior: 'deny', message: '操作已中止' })

    const request: AskUserRequest = {
      requestId: randomUUID(),
      sessionId,
      questions,
      toolInput: input,
      terminal,
    }

    return new Promise<PermissionResult>((resolve) => {
      const finish = (result: PermissionResult): void => {
        if (!this.pendingRequests.delete(request.requestId)) return
        signal.removeEventListener('abort', abort)
        resolve(result)
      }
      const abort = (): void => {
        finish({ behavior: 'deny', message: '操作已中止' })
        onResolved?.(request.requestId)
      }
      this.pendingRequests.set(request.requestId, { resolve: finish, request, onResolved })
      signal.addEventListener('abort', abort, { once: true })

      // 先登记再通知，避免事件监听方同步提交答案时找不到 pending request。
      sendToRenderer(request)
    })
  }

  /**
   * 响应 AskUser 请求（由 IPC handler 调用）
   *
   * @returns 对应的 sessionId，用于向渲染进程发送 resolved 事件；未找到返回 null
   */
  respondToAskUser(requestId: string, answers: Record<string, string>, terminalResponse?: AskUserResponse['terminalResponse']): string | null {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return null
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)
      || Object.keys(answers).length > 32
      || Object.entries(answers).some(([key, value]) => key.length > 10_000 || typeof value !== 'string' || value.length > 10_000)) {
      throw new Error('问答反馈格式无效或过长')
    }
    if (terminalResponse && (!pending.request.terminal
      || !['completed', 'problem'].includes(terminalResponse.outcome)
      || (terminalResponse.message !== undefined && (typeof terminalResponse.message !== 'string' || terminalResponse.message.length > 4_000)))) {
      throw new Error('终端操作反馈无效或过长')
    }

    const sessionId = pending.request.sessionId

    // 构建 updatedInput：保留原始输入 + 注入 answers
    const updatedInput: Record<string, unknown> = {
      ...pending.request.toolInput,
      answers,
      terminalInteraction: undefined,
      ...(pending.request.terminal ? {
        terminalInteraction: {
          terminalId: pending.request.terminal.terminalId,
          outcome: terminalResponse?.outcome ?? (Object.values(answers).includes('已完成，继续') ? 'completed' : 'problem'),
          message: terminalResponse?.message ?? Object.values(answers).join('\n'),
        },
      } : {}),
    }

    pending.resolve({
      behavior: 'allow' as const,
      updatedInput,
    })
    return sessionId
  }

  /** Cancel one pending request when an external interaction expires or cannot be delivered. */
  cancelAskUser(requestId: string, message = '用户未在有效期内回答'): string | null {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return null
    const sessionId = pending.request.sessionId
    pending.resolve({ behavior: 'deny' as const, message })
    return sessionId
  }

  /**
   * 获取当前所有待处理的 AskUser 请求（用于渲染进程重载后恢复状态）
   */
  getPendingRequests(): AskUserRequest[] {
    return [...this.pendingRequests.values()].map((p) => p.request)
  }

  /** 终端消失后解除接管，返回事实让原 Agent 决定后续，而非永久挂起。 */
  resolveTerminalUnavailable(terminalId: string): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.request.terminal?.terminalId !== terminalId) continue
      pending.resolve({ behavior: 'allow', updatedInput: {
        ...pending.request.toolInput,
        answers: {},
        terminalInteraction: { terminalId, outcome: 'unavailable', message: '终端已退出或关闭，请核验任务状态' },
      } })
      pending.onResolved?.(pending.request.requestId)
    }
  }

  /**
   * 清除指定会话的所有待处理 AskUser 请求
   */
  clearSessionPending(sessionId: string): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.request.sessionId === sessionId) {
        pending.resolve({ behavior: 'deny', message: '会话已结束' })
        pending.onResolved?.(pending.request.requestId)
      }
    }
  }

  /**
   * 从工具输入中解析问题列表
   *
   * SDK AskUserQuestion 工具输入格式：
   * { questions: [{ question, header, options: [{ label, description, preview }], multiSelect }] }
   */
  private parseQuestions(input: Record<string, unknown>): AskUserQuestion[] {
    const rawQuestions = input.questions
    if (!Array.isArray(rawQuestions)) return []

    return rawQuestions.map((q: unknown): AskUserQuestion => {
      if (!q || typeof q !== 'object' || Array.isArray(q)) throw new Error('问题格式无效')
      const raw = q as Record<string, unknown>
      const options = Array.isArray(raw.options)
        ? (raw.options as Array<Record<string, unknown>>).filter((o) => o && typeof o === 'object').map((o): AskUserQuestionOption => ({
            label: typeof o.label === 'string' ? o.label : '',
            description: typeof o.description === 'string' ? o.description : undefined,
            preview: typeof o.preview === 'string' ? o.preview.slice(0, 10_000) : undefined,
          }))
        : []

      return {
        question: typeof raw.question === 'string' ? raw.question : '',
        header: typeof raw.header === 'string' ? raw.header : undefined,
        options,
        multiSelect: raw.multiSelect === true,
      }
    })
  }
}

/** 全局 AskUser 服务实例 */
export const askUserService = new AgentAskUserService()
