import { execFile, type ChildProcess } from 'node:child_process'
import { redactProviderText } from './provider-log-buffer'

export class ProviderCommandError extends Error {
  constructor(readonly executable: string, readonly argsRedacted: string[], readonly exitCode: string | number | null,
    readonly signal: string | null, readonly stdoutExcerpt: string, readonly stderrExcerpt: string, readonly timedOut: boolean) {
    super(stderrExcerpt || stdoutExcerpt || `程序执行失败（${exitCode ?? signal ?? 'unknown'}）`)
    this.name = 'ProviderCommandError'
  }
}

export function runProviderCommand(executable: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const secrets = Object.entries(env ?? {}).filter(([key]) => /token|secret|key|authorization/i.test(key)).map(([, value]) => value ?? '')
  return new Promise((done, reject) => execFile(executable, args, { env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 8000, maxBuffer: 256 * 1024 }, (error, out, err) => {
    if (error) reject(new ProviderCommandError(executable, args.map((arg) => redactProviderText(arg, secrets)), error.code ?? null, error.signal ?? null,
      redactProviderText(out, secrets).slice(-4000), redactProviderText(err, secrets).slice(-4000), error.killed === true))
    else done(out + err)
  }))
}

/** 只停止调用方持有的子进程；重连前等待退出，避免自己的旧端点尚未释放。 */
export async function stopProviderProcess(child?: ChildProcess): Promise<void> {
  if (!child) return
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) { child.kill(); return }
  await new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); child.removeListener('close', finish); resolve() }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } finally { finish() } }, 3000)
    child.once('close', finish)
    try { child.kill() } catch { finish() }
  })
}
