/**
 * CodexOAuthSessionController 测试（第二轮 P0 验收：规范 §15 / §49）
 * 全部使用注入的 fake 依赖，绝不真连 Pi 或系统浏览器。
 */
import { describe, expect, it } from 'bun:test'
import { CodexOAuthSessionController, type CodexOAuthControllerDeps } from './codex-oauth-session-controller.ts'
import type { CodexOAuthCredentials, CodexOAuthSessionEvent } from '@proma/shared'

const credentials: CodexOAuthCredentials = { access: 'a', refresh: 'r', expires: 9999999999 }

function makeDeps(overrides?: Partial<CodexOAuthControllerDeps>): CodexOAuthControllerDeps & { calls: { openUrls: string[]; cancelled: number; submitted: string[] } } {
  const calls = { openUrls: [] as string[], cancelled: 0, submitted: [] as string[], runLoginCalls: 0 }
  return {
    calls,
    runLogin: (options) => {
      calls.runLoginCalls += 1
      void options
      return new Promise<CodexOAuthCredentials>(() => {})
    },
    openExternal: async (url) => { calls.openUrls.push(url) },
    cancelLogin: () => { calls.cancelled += 1 },
    submitCallbackUrl: (url) => { calls.submitted.push(url); return { accepted: true } },
    ...overrides,
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

describe('CodexOAuthSessionController（OAuth 会话状态机）', () => {
  it('start 立即返回 sessionId；auth_url 推送 waiting_authorization；自动打开浏览器每会话最多一次', async () => {
    const deps = makeDeps()
    deps.runLogin = (options) => {
      return new Promise<CodexOAuthCredentials>(() => {
        setTimeout(() => options.onAuthUrl?.('https://auth.example/first'), 5)
        setTimeout(() => options.onAuthUrl?.('https://auth.example/second'), 10)
      })
    }
    const controller = new CodexOAuthSessionController(deps)
    const events: CodexOAuthSessionEvent[] = []
    controller.onEvent((e) => events.push(e))
    const started = controller.start({ method: 'browser' })
    expect(started.sessionId).toBeTruthy()
    expect(started.snapshot?.status).toBe('starting')
    expect(deps.calls.openUrls).toHaveLength(0) // URL 未到时不打开浏览器
    await flush()
    await flush()
    const authEvents = events.filter((e) => e.type === 'auth_url')
    expect(authEvents).toHaveLength(2)
    expect(deps.calls.openUrls).toEqual(['https://auth.example/first']) // 第二次 auth_url 不再打开
    const snapshot = controller.getSnapshot(started.sessionId!)
    expect(snapshot?.status).toBe('waiting_authorization')
    expect(snapshot?.browserOpened).toBe(true)
  })

  it('运行中的会话上重复 start 复用同一 sessionId（双击防护）', async () => {
    const deps = makeDeps()
    const controller = new CodexOAuthSessionController(deps)
    const first = controller.start({ method: 'browser' })
    const second = controller.start({ method: 'browser' })
    expect(second.reused).toBe(true)
    expect(second.sessionId).toBe(first.sessionId)
    await flush()
    expect(deps.calls.runLoginCalls).toBe(1) // 只有一个后台登录流程
  })

  it('success 是终态：推送凭据、清空 active session，下次 start 创建全新会话', async () => {
    const deps = makeDeps()
    deps.runLogin = () => new Promise<CodexOAuthCredentials>((resolve) => setTimeout(() => resolve(credentials), 5))
    const controller = new CodexOAuthSessionController(deps)
    const events: CodexOAuthSessionEvent[] = []
    controller.onEvent((e) => events.push(e))
    const first = controller.start({ method: 'browser' })
    await flush()
    await flush()
    const success = events.find((e) => e.type === 'success')
    expect(success?.type).toBe('success')
    if (success?.type === 'success') expect(success.credentials).toContain('refresh')
    const second = controller.start({ method: 'browser' })
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(second.reused).toBe(false)
  })

  it('cancel 调用底层取消并进入 cancelled；不推送 error 事件', async () => {
    const deps = makeDeps()
    deps.runLogin = () => new Promise<CodexOAuthCredentials>((_, reject) => setTimeout(() => reject(new Error('登录已取消')), 5))
    const controller = new CodexOAuthSessionController(deps)
    const events: CodexOAuthSessionEvent[] = []
    controller.onEvent((e) => events.push(e))
    const started = controller.start({ method: 'browser' })
    controller.cancel(started.sessionId!)
    expect(deps.calls.cancelled).toBe(1)
    await flush()
    await flush()
    const statusEvents = events.filter((e) => e.type === 'status')
    expect(statusEvents.some((e) => e.type === 'status' && e.status === 'cancelled')).toBe(true)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(controller.getSnapshot(started.sessionId!)).toBeUndefined() // 终态清空
  })

  it('submitCallback 只 resolve 当前会话；错误 sessionId 拒绝', async () => {
    const deps = makeDeps()
    const controller = new CodexOAuthSessionController(deps)
    const started = controller.start({ method: 'browser' })
    const wrong = controller.submitCallback('ws_other', 'http://localhost:1455/auth/callback?code=x')
    expect(wrong.accepted).toBe(false)
    const right = controller.submitCallback(started.sessionId!, 'http://localhost:1455/auth/callback?code=x')
    expect(right.accepted).toBe(true)
    expect(deps.calls.submitted).toHaveLength(1)
    // 提交后进入 exchanging_token，会话仍有效（未重启登录）
    expect(controller.getSnapshot(started.sessionId!)?.status).toBe('exchanging_token')
  })
})
