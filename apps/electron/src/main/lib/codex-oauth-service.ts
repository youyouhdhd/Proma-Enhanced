/**
 * ChatGPT (OpenAI Codex) OAuth 登录服务
 *
 * 复用 Pi SDK（@earendil-works/pi-ai/oauth）内置的 Codex OAuth 流程完成登录：
 * - 登录必须在主进程（Node 侧）执行——SDK 使用 Node crypto 生成 PKCE，并在
 *   本地 127.0.0.1:1455 起回调服务接收授权码，无法在渲染进程运行。
 * - 本服务只负责"跑一次登录流程""刷新一次 token"两个纯操作；是否自动打开
 *   浏览器由 CodexOAuthSessionController 决定（每个会话最多自动打开一次）。
 *   SDK 内部的回调服务负责接收
 *   redirect 并完成 code→token 交换，最终返回 { access, refresh, expires, accountId }。
 *
 * token 的加密存储与过期刷新由上层（channel-manager / pi-model-registry）负责，
 * 本服务只封装"跑一次登录流程""刷新一次 token"两个纯操作。
 */

import type { CodexOAuthCredentials, CodexOAuthDeviceCode, CodexOAuthLoginMethod, CodexOAuthManualCodeRequest } from '@proma/shared'
import { runWithOAuthProxyScope } from './oauth-proxy-scope'
import { ManualCodeGate } from './codex-oauth-manual-gate'
/** Pi 0.80.10 将 OAuth 流程收敛到 ModelRuntime。保持动态 import，避免 Electron 主包将 Pi runtime 内联。 */
type PiSdk = typeof import('@earendil-works/pi-coding-agent')

let piSdkPromise: Promise<PiSdk> | undefined

function loadPiSdk(): Promise<PiSdk> {
  piSdkPromise ??= import('@earendil-works/pi-coding-agent')
  return piSdkPromise
}

type OAuthCredential = { type: 'oauth'; access: string; refresh: string; expires: number; [key: string]: unknown }

/**
 * Pi 的 ModelRuntime 只要求 CredentialStore 的结构契约。OAuth 凭据仍由 Proma
 * channel-manager 加密持久化；这里使用内存 store，避免 Pi 写入自己的 ~/.pi 配置。
 */
function createEphemeralCredentialStore(initial?: OAuthCredential) {
  let credential = initial
  return {
    async read(): Promise<OAuthCredential | undefined> { return credential },
    async list(): Promise<readonly { providerId: string; type: 'oauth' }[]> {
      return credential ? [{ providerId: 'openai-codex', type: 'oauth' }] : []
    },
    async modify(_providerId: string, fn: (current: OAuthCredential | undefined) => Promise<OAuthCredential | undefined>) {
      credential = await fn(credential)
      return credential
    },
    async delete(): Promise<void> { credential = undefined },
  }
}

function normalizeCredentials(value: unknown): CodexOAuthCredentials {
  if (!value || typeof value !== 'object') throw new Error('Pi OAuth 未返回有效凭据')
  const credential = value as Partial<OAuthCredential>
  if (typeof credential.access !== 'string' || typeof credential.refresh !== 'string' || typeof credential.expires !== 'number') {
    throw new Error('Pi OAuth 返回的凭据缺少 access、refresh 或 expires')
  }
  return {
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    ...(typeof credential.accountId === 'string' && credential.accountId ? { accountId: credential.accountId } : {}),
  }
}

/** 进行中的登录流程的取消控制器（同一时刻只允许一个登录流程）。 */
let activeLoginAbort: AbortController | undefined
/** 当前登录的 manual_code 输入闸门（与 activeLoginAbort 同生命周期）。 */
let activeManualGate: ManualCodeGate | undefined

/**
 * 提交手动授权回调 URL（渲染进程「完成登录」按钮）。
 * 只有当前登录存在且尚未完成时首次提交生效；URL 含授权码，此处绝不记录。
 */
export function submitCodexOAuthCallbackUrl(callbackUrl: string): { accepted: boolean } {
  return activeManualGate ? activeManualGate.submit(callbackUrl) : { accepted: false }
}

/**
 * 注意：Pi 0.80.10 的公开 OAuth API 不再接收 fetch 注入。依赖升级补丁会把
 * Proma 的代理 fetch 重新接回该流程；本 service 只负责与公开 ModelRuntime 交互。
 */

export interface CodexLoginCallbacks {
  /** SDK 生成授权 URL 后回调，用于（除自动开浏览器外）通知渲染层展示 URL。 */
  onAuthUrl?: (url: string) => void
  /** Pi 生成 device code 后回调，供 UI 展示、复制或交给另一台设备扫码。 */
  onDeviceCode?: (deviceCode: CodexOAuthDeviceCode) => void
  /** 进度消息回调。 */
  onProgress?: (message: string) => void
  /**
   * Pi manual_code prompt 触发：localhost 回调与手动输入在 Pi 内部竞速。
   * 实现方借此通知 UI 展示手动回调输入框；用户提交的 URL 由
   * submitCodexOAuthCallbackUrl 递回内部 ManualCodeGate（首次生效），
   * 解析、state 校验与 token 交换全部由 Pi 完成。
   */
  onManualCodeRequested?: (request: CodexOAuthManualCodeRequest) => void
}

export interface CodexLoginOptions extends CodexLoginCallbacks {
  /** 默认系统浏览器；网络受限时可选择 RFC 8628 device-code 流程。 */
  method?: CodexOAuthLoginMethod
}

/**
 * 发起一次 ChatGPT (Codex) 浏览器 OAuth 登录。
 *
 * 成功返回规范化的 OAuth 凭据；用户取消或失败则抛错。
 * 登录期间自动用系统浏览器打开授权页，SDK 内部回调服务（:1455）接收授权码。
 */
export async function loginCodexOAuth(options?: CodexLoginOptions): Promise<CodexOAuthCredentials> {
  const sdk = await loadPiSdk()
  const method = options?.method ?? 'browser'

  // 取消上一个仍在进行的登录流程，避免 :1455 端口占用与并发回调。
  activeLoginAbort?.abort()
  const abort = new AbortController()
  activeLoginAbort = abort
  const manualGate = new ManualCodeGate()
  activeManualGate = manualGate

  try {
    return await runWithOAuthProxyScope(async () => {
      const runtime = await sdk.ModelRuntime.create({
        credentials: createEphemeralCredentialStore(),
        allowModelNetwork: false,
      })
      const credentials = await runtime.login('openai-codex', 'oauth', {
        signal: abort.signal,
        prompt: async (prompt) => {
          if (prompt.type === 'select') return method
          if (prompt.type === 'manual_code' && options?.onManualCodeRequested) {
            // Pi 已实现 parseAuthorizationInput（完整 URL / code#state / query / 纯 code）
            // 与 state 校验，这里只把用户输入原样交还，绝不解析或记录其内容。
            const request: CodexOAuthManualCodeRequest = {
              message: prompt.message,
              ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
            }
            const onAbort = (): void => manualGate.cancel(new Error('登录已取消'))
            prompt.signal?.addEventListener('abort', onAbort, { once: true })
            abort.signal.addEventListener('abort', onAbort, { once: true })
            return manualGate.waitForInput(request).finally(() => {
              prompt.signal?.removeEventListener('abort', onAbort)
              abort.signal.removeEventListener('abort', onAbort)
            })
          }
          return new Promise<string>((_resolve, reject) => {
            prompt.signal?.addEventListener('abort', () => reject(new Error('登录已取消')), { once: true })
            abort.signal.addEventListener('abort', () => reject(new Error('登录已取消')), { once: true })
          })
        },
        notify: (event) => {
          if (event.type === 'auth_url') {
            // 只上报 URL；是否自动打开浏览器由 CodexOAuthSessionController 决定（每会话最多一次）。
            options?.onAuthUrl?.(event.url)
          } else if (event.type === 'device_code') {
            console.log(`[Codex OAuth] 请在浏览器中授权（设备码：${event.userCode}）`)
            options?.onDeviceCode?.({ userCode: event.userCode, verificationUri: event.verificationUri })
          } else if (event.type === 'progress' || event.type === 'info') {
            console.log(`[Codex OAuth] ${event.message}`)
            options?.onProgress?.(event.message)
          }
        },
      })
      return normalizeCredentials(credentials)
    })
  } finally {
    if (activeLoginAbort === abort) {
      activeLoginAbort = undefined
      activeManualGate = undefined
    }
  }
}

/** 取消进行中的 Codex OAuth 登录流程（若有）。 */
export function cancelCodexOAuthLogin(): void {
  activeLoginAbort?.abort()
  activeLoginAbort = undefined
  activeManualGate?.cancel(new Error('登录已取消'))
  activeManualGate = undefined
}

/**
 * 用 refresh token 刷新 Codex OAuth 凭据。
 *
 * 返回新的规范化凭据（含新的 expires）。SDK 在 refresh token 未轮换时会复用旧值。
 */
export async function refreshCodexOAuth(refreshToken: string): Promise<CodexOAuthCredentials> {
  const sdk = await loadPiSdk()
  return runWithOAuthProxyScope(async () => {
    const store = createEphemeralCredentialStore({
      type: 'oauth',
      access: '',
      refresh: refreshToken,
      expires: 0,
    })
    const runtime = await sdk.ModelRuntime.create({ credentials: store, allowModelNetwork: false })
    // getAuth() 走 provider 的标准 refresh 流程，并通过 store 原子更新凭据。
    await runtime.getAuth('openai-codex')
    return normalizeCredentials(await store.read())
  })
}
