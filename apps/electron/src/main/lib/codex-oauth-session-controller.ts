/**
 * CodexOAuthSessionController — Codex OAuth 会话状态机（第三轮强化）
 *
 * 第二轮解决了「URL 出现时机倒置 / session 循环」；第三轮进一步确立：
 *
 *   「登录」按钮只负责准备授权信息，绝不打开浏览器。
 *
 * - start() 创建会话并立即返回 sessionId，登录在后台继续；
 * - auth_url / device_code 事件只保存并推送授权信息，绝不调用 openExternal（§45/§52）；
 * - 打开浏览器的唯一入口是 openAuthorizationPage(sessionId)——由用户点击
 *   「在浏览器中打开」触发，可重复点击（§43），只能打开当前会话的官方授权地址（§46）；
 * - 打开失败不终止会话（§42）；
 * - 同一时刻最多一个进行中的会话；运行中的会话上重复 start 复用同一 sessionId（§55）；
 * - manual_code prompt 只表示「可以回填 callback」，绝不重新创建 OAuth 流程。
 */

import { randomUUID } from 'node:crypto'
import type {
  CodexOAuthCredentials,
  CodexOAuthLoginMethod,
  CodexOAuthOpenPageResult,
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

/** 可注入的底层操作（测试时替换为 fake，绝不真连 Pi / 系统浏览器）。 */
export interface CodexOAuthControllerDeps {
  runLogin(options: CodexLoginOptions): Promise<CodexOAuthCredentials>
  /** 仅由 openAuthorizationPage 使用（用户显式动作） */
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

interface SessionState {
  id: string
  status: CodexOAuthStatus
  method: CodexOAuthLoginMethod
  authUrl?: string
  deviceCode?: { userCode: string; verificationUri: string }
  manualInputReady: boolean
  createdAt: number
  error?: string
  /** 终态后由 finally 清理；open/submit/cancel 用它判断会话是否仍有效 */
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
   * 不打开浏览器——授权 URL 生成后由用户决定复制还是打开（§38/§39）。
   * 已有运行中的会话时不创建新会话（reused=true），防止双击产生并发 OAuth。
   */
  start(options?: { method?: CodexOAuthLoginMethod }): CodexOAuthStartResult {
    const active = this.session
    if (active && RUNNING_STATUSES.has(active.status)) {
      return { sessionId: active.id, reused: true, snapshot: this.snapshotOf(active) }
    }
    const state: SessionState = {
      id: randomUUID(),
      status: 'starting',
      method: options?.method === 'device_code' ? 'device_code' : 'browser',
      manualInputReady: false,
      createdAt: Date.now(),
      finished: false,
    }
    this.session = state
    this.emit({ sessionId: state.id, type: 'status', status: 'starting' })
    void this.run(state)
    return { sessionId: state.id, reused: false, snapshot: this.snapshotOf(state) }
  }

  /** 查询当前会话快照（渲染层恢复 UI 用；恢复不会触发浏览器）。 */
  getSnapshot(sessionId: string): CodexOAuthSessionSnapshot | undefined {
    return this.session?.id === sessionId ? this.snapshotOf(this.session) : undefined
  }

  /**
   * 用户显式打开授权页面（唯一允许调用系统浏览器的入口，§46/§52）。
   * URL 来自 Main Process 中保存的当前会话，Renderer 不能传入任意 URL。
   * 可重复点击；失败不终止会话（§42/§43）。
   */
  async openAuthorizationPage(sessionId: string): Promise<CodexOAuthOpenPageResult> {
    if (!this.session || this.session.id !== sessionId) {
      return { success: false, error: '当前没有进行中的登录会话' }
    }
    const url = this.session.authUrl ?? this.session.deviceCode?.verificationUri
    if (!url) {
      return { success: false, error: '授权网址尚未生成，请稍候' }
    }
    // 安全边界：只允许 https 授权地址（auth.openai.com / 官方验证页）
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { success: false, error: '授权网址无效' }
    }
    if (parsed.protocol !== 'https:') {
      return { success: false, error: '授权网址协议异常，已拒绝打开' }
    }
    try {
      await this.deps.openExternal(url)
      return { success: true }
    } catch (error) {
      // 打开失败不影响 OAuth 会话：URL 仍可复制手动打开
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: '无法打开系统浏览器：' + message }
    }
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
          // 只保存 + 推送；绝不调用 openExternal（§45）
          state.authUrl = url
          this.transition(state, 'waiting_authorization')
          this.emit({ sessionId: state.id, type: 'auth_url', url })
        },
        onDeviceCode: (deviceCode) => {
          // 只保存 + 推送；二维码/浏览器都交给用户决定（§50）
          state.deviceCode = { userCode: deviceCode.userCode, verificationUri: deviceCode.verificationUri }
          this.transition(state, 'waiting_authorization')
          this.emit({ sessionId: state.id, type: 'device_code', deviceCode })
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
      method: state.method,
      ...(state.authUrl ? { authUrl: state.authUrl } : {}),
      ...(state.deviceCode ? { deviceCode: state.deviceCode } : {}),
      manualInputReady: state.manualInputReady,
      createdAt: state.createdAt,
      ...(state.error ? { error: state.error } : {}),
    }
  }
}

/** 主进程单例 */
export const codexOAuthSessionController = new CodexOAuthSessionController()
