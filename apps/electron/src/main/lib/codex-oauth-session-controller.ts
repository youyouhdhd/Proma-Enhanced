/**
 * CodexOAuthSessionController — Codex OAuth 会话状态机（第二轮优化 P0）
 *
 * 解决的第一轮问题：登录被当成一次 request-response（await 整个 OAuth 才返回 UI），
 * 导致授权 URL 出现时机倒置、表单重挂载丢凭据、重复点击重启流程形成死循环。
 *
 * 现在的契约（对应第二轮开发规范 §3-§15）：
 * - start() 立即返回 sessionId，登录在后台继续；
 * - auth_url / device_code / manual_input_ready / progress / success / error 全部作为事件推送；
 * - 同一时刻最多一个进行中的会话；运行中的会话上重复 start 复用同一 sessionId（防双击）；
 * - 自动打开浏览器每个会话最多一次（browserOpened 守卫）；
 * - manual_code prompt 只表示「可以回填 callback」，绝不重新创建 OAuth 流程；
 * - success / error / cancelled 是终态：清空 active session，之后 start 才会创建新会话。
 */

import { randomUUID } from 'node:crypto'
import type {
  CodexOAuthCredentials,
  CodexOAuthLoginMethod,
  CodexOAuthSessionEvent,
  CodexOAuthSessionSnapshot,
  CodexOAuthStartResult,
  CodexOAuthStatus,
} from '@proma/shared'
import { serializeCodexCredentials } from '@proma/shared'
import {
  loginCodexOAuth,
  cancelCodexOAuthLogin,
  submitCodexOAuthCallbackUrl,
  type CodexLoginOptions,
} from './codex-oauth-service'

/** 可注入的底层登录操作（测试时替换为 fake，绝不真连 Pi）。 */
export interface CodexOAuthControllerDeps {
  runLogin(options: CodexLoginOptions): Promise<CodexOAuthCredentials>
  openExternal(url: string): Promise<unknown>
  cancelLogin(): void
  submitCallbackUrl(url: string): { accepted: boolean }
}

/** electron 的 shell 延迟加载：bun test 环境不能静态解析 electron 模块 */
let electronShell: { openExternal(url: string): Promise<void> } | undefined
async function defaultOpenExternal(url: string): Promise<unknown> {
  electronShell ??= (await import('electron')).shell
  return electronShell.openExternal(url)
}

const defaultDeps: CodexOAuthControllerDeps = {
  runLogin: (options) => loginCodexOAuth(options),
  openExternal: (url) => defaultOpenExternal(url),
  cancelLogin: () => cancelCodexOAuthLogin(),
  submitCallbackUrl: (url) => submitCodexOAuthCallbackUrl(url),
}

interface SessionState extends CodexOAuthSessionSnapshot {
  method: CodexOAuthLoginMethod
  /** 终态后由 finally 清理；submit/cancel 用它判断会话是否仍有效 */
  finished: boolean
}

/** 进行中（可复用/可取消）的状态集合 */
const RUNNING_STATUSES: ReadonlySet<CodexOAuthStatus> = new Set(['starting', 'waiting_authorization', 'exchanging_token'])

export class CodexOAuthSessionController {
  private session: SessionState | null = null
  private readonly listeners = new Set<(event: CodexOAuthSessionEvent) => void>()

  constructor(private readonly deps: CodexOAuthControllerDeps = defaultDeps) {}

  /** 订阅会话事件（IPC 层广播给所有窗口，渲染层按 sessionId 过滤）。返回取消订阅。 */
  onEvent(listener: (event: CodexOAuthSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 发起登录：立即返回 sessionId，登录在后台继续。
   * 已有运行中的会话时不创建新会话（reused=true），防止双击/重入产生并发 OAuth。
   */
  start(options?: { method?: CodexOAuthLoginMethod; autoOpenBrowser?: boolean }): CodexOAuthStartResult {
    const active = this.session
    if (active && RUNNING_STATUSES.has(active.status)) {
      return { sessionId: active.id, reused: true, snapshot: this.snapshotOf(active) }
    }
    const state: SessionState = {
      id: randomUUID(),
      status: 'starting',
      autoOpenBrowser: options?.autoOpenBrowser !== false,
      browserOpened: false,
      manualInputReady: false,
      createdAt: Date.now(),
      method: options?.method === 'device_code' ? 'device_code' : 'browser',
      finished: false,
    }
    this.session = state
    this.emit({ sessionId: state.id, type: 'status', status: 'starting' })
    void this.run(state)
    return { sessionId: state.id, reused: false, snapshot: this.snapshotOf(state) }
  }

  /** 查询当前会话快照（渲染层恢复 UI 用）。 */
  getSnapshot(sessionId: string): CodexOAuthSessionSnapshot | undefined {
    return this.session?.id === sessionId ? this.snapshotOf(this.session) : undefined
  }

  /**
   * 用户粘贴授权回调 URL。只 resolve 当前会话的等待，绝不重启登录——
   * 解析、state 校验与 token 交换全部由 Pi 在原流程内完成。
   */
  submitCallback(sessionId: string, callbackUrl: string): { accepted: boolean } {
    if (!this.session || this.session.id !== sessionId || this.session.finished) {
      return { accepted: false }
    }
    const result = this.deps.submitCallbackUrl(callbackUrl)
    if (result.accepted) {
      this.transition(this.session, 'exchanging_token')
    }
    return result
  }

  /** 取消会话：终止后台登录并清理本地回调服务器。 */
  cancel(sessionId: string): void {
    if (!this.session || this.session.id !== sessionId || this.session.finished) return
    this.deps.cancelLogin()
    // 终态与清理由 run() 的 catch/finally 统一处理（abort 会触发 runLogin 抛错）。
  }

  private async run(state: SessionState): Promise<void> {
    try {
      const credentials = await this.deps.runLogin({
        method: state.method,
        onAuthUrl: (url) => {
          // auth_url 是中间事件：保存 → 状态推进 → 立即推送；是否自动开浏览器由本控制器决定。
          state.authUrl = url
          this.transition(state, 'waiting_authorization')
          this.emit({ sessionId: state.id, type: 'auth_url', url })
          if (state.autoOpenBrowser && !state.browserOpened) {
            state.browserOpened = true
            this.deps.openExternal(url).catch((err) => console.error('[Codex OAuth] 自动打开浏览器失败:', err))
          }
        },
        onDeviceCode: (deviceCode) => {
          this.emit({ sessionId: state.id, type: 'device_code', deviceCode })
          if (state.autoOpenBrowser && !state.browserOpened) {
            state.browserOpened = true
            this.deps.openExternal(deviceCode.verificationUri).catch((err) => console.error('[Codex OAuth] 打开设备授权页失败:', err))
          }
        },
        onManualCodeRequested: (request) => {
          // manual_code ≠ 「开始登录」：只表示 OAuth session 已就绪、可回填 callback。
          state.manualInputReady = true
          this.transition(state, 'waiting_authorization')
          this.emit({ sessionId: state.id, type: 'manual_input_ready', request })
        },
        onProgress: (message) => {
          this.emit({ sessionId: state.id, type: 'progress', message })
        },
      })
      state.finished = true
      state.status = 'success'
      this.emit({ sessionId: state.id, type: 'status', status: 'success' })
      this.emit({
        sessionId: state.id,
        type: 'success',
        credentials: serializeCodexCredentials(credentials),
        ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
      })
    } catch (error) {
      state.finished = true
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = message.includes('取消') || message.toLowerCase().includes('abort')
      state.status = cancelled ? 'cancelled' : 'error'
      state.error = message
      this.emit({ sessionId: state.id, type: 'status', status: state.status })
      if (!cancelled) {
        this.emit({ sessionId: state.id, type: 'error', message })
      }
    } finally {
      // 登录成功之后绝不允许旧会话残留：下一次 start 必然创建全新会话。
      if (this.session?.id === state.id) this.session = null
    }
  }

  private transition(state: SessionState, status: CodexOAuthStatus): void {
    if (state.finished || state.status === status) return
    state.status = status
    this.emit({ sessionId: state.id, type: 'status', status })
  }

  private emit(event: CodexOAuthSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[Codex OAuth] 会话事件监听器异常:', err)
      }
    }
  }

  private snapshotOf(state: SessionState): CodexOAuthSessionSnapshot {
    return {
      id: state.id,
      status: state.status,
      ...(state.authUrl ? { authUrl: state.authUrl } : {}),
      autoOpenBrowser: state.autoOpenBrowser,
      browserOpened: state.browserOpened,
      manualInputReady: state.manualInputReady,
      createdAt: state.createdAt,
      ...(state.error ? { error: state.error } : {}),
    }
  }
}

/** 主进程单例 */
export const codexOAuthSessionController = new CodexOAuthSessionController()
