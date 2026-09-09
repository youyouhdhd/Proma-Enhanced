/**
 * TunnelProcessRunner — tunnel-client 子进程统一运行器（V5 §20）
 * 统一负责：env 注入（run / doctor 完全一致）、shell:false、UTF-8 跨 Buffer 解码、
 * 输出脱敏（Runtime Key 绝不外泄到日志/诊断详情）、超时、退出处理。
 * 避免 run / doctor 实现漂移（V5 核心原则一：Doctor 必须使用与 Run 完全相同的凭据环境）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export interface CapturedProcessResult {
  exitCode: number | undefined
  stdout: string
  stderr: string
}

export type TunnelSpawn = ((
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; windowsHide: boolean; shell: false },
) => ChildProcess) & ((
  executable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; encoding: 'utf8'; timeout?: number; windowsHide: boolean; shell?: false },
) => { status: number | null; stdout?: string; stderr?: string; error?: Error & { code?: string } })

/** 输出脱敏：把出现的敏感值替换为占位符 */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let result = text
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      result = result.split(secret).join('[REDACTED]')
    }
  }
  return result
}

export class TunnelProcessRunner {
  /**
   * 统一凭据环境：run / doctor / 未来诊断共用（V5 §4 / V6 §14）。
   * Key 与 Local MCP Bearer 只经环境变量注入，绝不进 argv。
   */
  buildTunnelClientEnv(input: { runtimeKey: string; localMcpBearerToken?: string; controlPlaneProxy?: string }): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CONTROL_PLANE_API_KEY: input.runtimeKey,
    }
    if (input.localMcpBearerToken) {
      env.PROMA_MCP_AUTH_HEADER = 'Bearer ' + input.localMcpBearerToken
    }
    if (input.controlPlaneProxy) env.CONTROL_PLANE_HTTP_PROXY = input.controlPlaneProxy
    const bypass = [...new Set([...(env.NO_PROXY ?? env.no_proxy ?? '').split(',').filter(Boolean), '127.0.0.1', 'localhost'])].join(',')
    env.NO_PROXY = bypass; env.no_proxy = bypass
    return env
  }

  /** 带超时的单次捕获式运行（--version / doctor / help 校验共用） */
  async runCapture(
    executable: string,
    args: string[],
    options: { runtimeKey?: string; localMcpBearerToken?: string; timeoutMs?: number; controlPlaneProxy?: string },
  ): Promise<CapturedProcessResult> {
    const env = options.runtimeKey !== undefined
      ? this.buildTunnelClientEnv({ runtimeKey: options.runtimeKey, controlPlaneProxy: options.controlPlaneProxy, ...(options.localMcpBearerToken ? { localMcpBearerToken: options.localMcpBearerToken } : {}) })
      : { ...process.env }
    return new Promise<CapturedProcessResult>((resolve) => {
      const child = spawn(executable, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false, // V5 §12：Windows 不经 cmd.exe，无乱码、缺失命令得到 ENOENT
      })
      const outDecoder = new StringDecoder('utf8')
      const errDecoder = new StringDecoder('utf8')
      let out = ''
      let err = ''
      child.stdout?.on('data', (chunk: Buffer) => { out += outDecoder.write(chunk) })
      child.stderr?.on('data', (chunk: Buffer) => { err += errDecoder.write(chunk) })
      const timer = options.timeoutMs
        ? setTimeout(() => {
            try { child.kill() } catch { /* 已退出 */ }
          }, options.timeoutMs)
        : null
      timer?.unref?.()
      child.on('error', (err2) => {
        if (timer) clearTimeout(timer)
        resolve({ exitCode: -1, stdout: out, stderr: err + err2.message })
      })
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        // 收尾：冲出 decoder 残留的多字节字符
        out += outDecoder.end()
        err += errDecoder.end()
        resolve({ exitCode: code ?? undefined, stdout: out, stderr: err })
      })
    })
  }

  /** 对捕获结果统一脱敏（Runtime Key / 可能出现在输出中的敏感值） */
  redact(result: CapturedProcessResult, runtimeKey?: string, localMcpBearerToken?: string): CapturedProcessResult {
    return {
      exitCode: result.exitCode,
      stdout: redactSecrets(result.stdout, [runtimeKey, localMcpBearerToken, process.env.CONTROL_PLANE_API_KEY, process.env.PROMA_MCP_AUTH_HEADER]),
      stderr: redactSecrets(result.stderr, [runtimeKey, localMcpBearerToken, process.env.CONTROL_PLANE_API_KEY, process.env.PROMA_MCP_AUTH_HEADER]),
    }
  }
}
