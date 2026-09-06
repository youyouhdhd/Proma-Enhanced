/**
 * shell_execute — 高风险工具：在工作区内执行命令
 *
 * 安全要求（设计文档 §21/§53）：
 * - cwd 必须经守卫确认位于 workspace 内；
 * - 默认关闭，需 accessMode=full 且 tools.shell=true；
 * - 支持超时与 abort；stdout/stderr 截断上限。
 */

import { spawn } from 'node:child_process'
import { guardWorkspacePath } from './security'
import { toolOk, toolError } from './types'
import type { LocalToolDefinition } from './types'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_CHARS = 200_000

export const shellExecuteTool: LocalToolDefinition = {
  name: 'shell_execute',
  description: '在工作区内执行本地 Shell 命令（高风险工具，需要显式开启）。返回 exitCode/stdout/stderr。',
  inputSchema: {
    type: 'object',
    required: ['command'],
    properties: {
      workspace_id: { type: 'string', description: '目标项目（workspace_list 返回的 id）；仅授权一个项目时可省略' },
      command: { type: 'string', description: '要执行的命令（经 shell 解析）' },
      cwd: { type: 'string', description: '相对工作区根的工作目录，默认 "."' },
      timeoutMs: { type: 'number', description: '超时毫秒数，默认 120000，上限 600000' },
    },
  },
  risk: 'execute',
  async execute(input, context) {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (!command) return toolError('INVALID_INPUT', 'command 不能为空')
    const rawCwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : '.'
    const guarded = guardWorkspacePath(context.rootPath, rawCwd, { mustExist: true })
    if ('error' in guarded) return guarded
    const timeoutMs = Math.min(Math.max(Math.floor(Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS)

    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: guarded.path,
        shell: true,
        windowsHide: true,
        env: { ...process.env },
      })
      let stdout = ''; let stderr = ''; let timedOut = false; let settled = false
      const kill = (): void => { timedOut = true; try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
      const timer = setTimeout(kill, timeoutMs)
      const onAbort = (): void => { timedOut = false; try { child.kill('SIGKILL') } catch { /* 已退出 */ } }
      context.signal?.addEventListener('abort', onAbort, { once: true })
      const finish = (exitCode: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        context.signal?.removeEventListener('abort', onAbort)
        if (context.signal?.aborted) {
          resolve(toolError('ABORTED', '执行已被中止'))
          return
        }
        const out = stdout.slice(0, MAX_OUTPUT_CHARS)
        const err = stderr.slice(0, MAX_OUTPUT_CHARS)
        resolve(toolOk(
          { exitCode, timedOut, stdout: out, stderr: err },
          `exitCode=${exitCode ?? 'signal'}${timedOut ? ' (timed out)' : ''}\n${out}${err ? '\n[stderr]\n' + err : ''}`.slice(0, MAX_OUTPUT_CHARS),
        ))
      }
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.on('error', (err) => { settled = true; clearTimeout(timer); resolve(toolError('EXECUTION_ERROR', err.message)) })
      child.on('close', (code) => finish(code))
    })
  },
}
