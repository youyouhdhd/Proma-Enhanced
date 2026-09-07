/**
 * CodexOAuthSessionController 测试（第三轮验收：TC-CODEX-01 ~ TC-CODEX-11 核心）
 * 全部使用注入的 fake 依赖，绝不真连 Pi / 系统浏览器。
 */
import { describe, expect, it } from 'bun:test'
import { CodexOAuthSessionController, type CodexOAuthControllerDeps } from './codex-oauth-session-controller.ts'
import type { CodexOAuthCredentials, CodexOAuthSessionEvent } from '@proma/shared'

const credentials: CodexOAuthCredentials = { access: 'a', refresh: 'r', expires: 9999999999 }
const AUTH_URL = 'https://auth.openai.com/oauth/authorize?state=s'

function makeDeps(overrides?: Partial<CodexOAuthControllerDeps>): CodexOAuthControllerDeps & { calls: { openUrls: string[]; cancelled: number; submitted: string[]; runLoginCalls: number } } {
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

describe('CodexOAuthSessionController（第三轮：显式浏览器动作）', () => {
  it('TC-CODEX-01/02：点击登录绝不打开浏览器；auth_url 到达后浏览器调用次数仍为 0', async () => {
    const deps = makeDeps()
    deps.runLogin = (options) => new Promise<CodexOAuthCredentials>(() => {
      setTimeout(() => options.onAuthUrl?.(AUTH_URL), 5)
    })
    const controller = new CodexOAuthSessionController(deps)
    const events: CodexOAuthSessionEvent[] = []
    controller.onEvent((e) => events.push(e))
    const started = controller.start({ method: 'browser' })
    expect(started.sessionId).toBeTruthy()
    await flush()
    await flush()
    expect(events.some((e) => e.type === 'auth_url' && e.url === AUTH_URL)).toBe(true)
    // 最重要验收项：整个准备阶段系统浏览器调用次数 = 0
    expect(deps.calls.openUrls).toHaveLength(0)
    const snapshot = controller.getSnapshot(started.sessionId!)
    expect(snapshot?.status).toBe('waiting_authorization')
    expect(snapshot?.authUrl).toBe(AUTH_URL)
  })

  it('TC-CODEX-10：重复点击登录只保留一个会话', async () => {
    const deps = makeDeps()
    const controller = new CodexOAuthSessionController(deps)
    const first = controller.start({ method: 'browser' })
    const second = controller.start({ method: 'browser' })
    expect(second.reused).toBe(true)
    expect(second.sessionId).toBe(first.sessionId)
    await flush()
    expect(deps.calls.runLoginCalls).toBe(1)
  })

  it('TC-CODEX-04/05：openAuthorizationPage 只由用户触发、URL 来自当前会话、可重复点击', async () => {
    const deps = makeDeps()
    deps.runLogin = (options) => new Promise<CodexOAuthCredentials>(() => { setTimeout(() => options.onAuthUrl?.(AUTH_URL), 5) })
    const controller = new CodexOAuthSessionController(deps)
    const started = controller.start({ method: 'browser' })
    await flush()
    await flush()
    const wrong = await controller.openAuthorizationPage('session-other')
    expect(wrong.success).toBe(false)
    const first = await controller.openAuthorizationPage(started.sessionId!)
    expect(first.success).toBe(true)
    const second = await controller.openAuthorizationPage(started.sessionId!)
    expect(second.success).toBe(true)
    expect(deps.calls.openUrls).toEqual([AUTH_URL, AUTH_URL])
  })

  it('TC-CODEX-06：浏览器打开失败不终止 OAuth 会话', async () => {
    const deps = makeDeps()
    deps.runLogin = (options) => new Promise<CodexOAuthCredentials>(() => { setTimeout(() => options.onAuthUrl?.(AUTH_URL), 5) })
    deps.openExternal = async () => { throw new Error('spawn failed') }
    const controller = new CodexOAuthSessionController(deps)
    const started = controller.start({ method: 'browser' })
    await flush()
    await flush()
    const result = await controller.openAuthorizationPage(started.sessionId!)
    expect(result.success).toBe(false)
    expect(result.error).toContain('无法打开系统浏览器')
    // 会话仍有效：手动 callback 依然可以提交
    const submit = controller.submitCallback(started.sessionId!, 'http://localhost:1455/auth/callback?code=x')
    expect(submit.accepted).toBe(true)
  })

  it('TC-CODEX-07：Device Code 不自动打开浏览器；openAuthorizationPage 打开验证地址', async () => {
    const deps = makeDeps()
    deps.runLogin = (options) => new Promise<CodexOAuthCredentials>(() => {
      setTimeout(() => options.onDeviceCode?.({ userCode: 'ABCD-EFGH', verificationUri: 'https://auth.openai.com/device' }), 5)
    })
    const controller = new CodexOAuthSessionController(deps)
    const started = controller.start({ method: 'device_code' })
    await flush()
    await flush()
    expect(deps.calls.openUrls).toHaveLength(0)
    const snapshot = controller.getSnapshot(started.sessionId!)
    expect(snapshot?.deviceCode?.userCode).toBe('ABCD-EFGH')
    const opened = await controller.openAuthorizationPage(started.sessionId!)
    expect(opened.success).toBe(true)
    expect(deps.calls.openUrls).toEqual(['https://auth.openai.com/device'])
  })

  it('TC-CODEX-08：success 终态推送凭据并清空会话', async () => {
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
    const second = controller.start({ method: 'browser' })
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(second.reused).toBe(false)
    // 成功后旧 sessionId 无法再打开浏览器（TC-CODEX-08：不得再次打开）
    const reopen = await controller.openAuthorizationPage(first.sessionId!)
    expect(reopen.success).toBe(false)
  })

  it('TC-CODEX-09：cancel 清理会话且不推送 error', async () => {
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
    expect(events.some((e) => e.type === 'status' && e.status === 'cancelled')).toBe(true)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(controller.getSnapshot(started.sessionId!)).toBeUndefined()
  })

  it('TC-CODEX-11：submitCallback 只 resolve 当前会话', async () => {
    const deps = makeDeps()
    const controller = new CodexOAuthSessionController(deps)
    const started = controller.start({ method: 'browser' })
    const wrong = controller.submitCallback('session-other', 'http://localhost:1455/auth/callback?code=x')
    expect(wrong.accepted).toBe(false)
    const right = controller.submitCallback(started.sessionId!, 'http://localhost:1455/auth/callback?code=x')
    expect(right.accepted).toBe(true)
    expect(deps.calls.submitted).toHaveLength(1)
    expect(controller.getSnapshot(started.sessionId!)?.status).toBe('exchanging_token')
  })
})
