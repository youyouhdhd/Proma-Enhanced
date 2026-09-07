/**
 * TunnelClientManager — OpenAI Tunnel Client 程序解析 / 检测 / 验证（规范 §11-§14）
 *
 * 查找策略：custom-path（用户指定文件）→ managed（PROMA 管理目录）→ system-path（系统 PATH）。
 * 所有检测一律 spawn(executable, ['--version'], { shell: false })：
 * - Windows 不再经过 cmd.exe：命令不存在得到 ENOENT 而不是代码页乱码（§13/§14）；
 * - 判定 installed 必须 status === 0，不能只看「进程能创建」（§13）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PromaMcpTunnelDetection, PromaMcpTunnelSettings } from '@proma/shared'
import { openAiTunnelClientAdapter } from './tunnel-client-adapter'
import type { TunnelManagerDeps } from './tunnel-client-types'

const DEFAULT_DEPS: TunnelManagerDeps = {
  spawnSync: (executable, args, options) => {
    const result = spawnSync(executable, args, options)
    return {
      status: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      error: result.error,
    }
  },
  exists: (path) => existsSync(path),
  isFile: (path) => { try { return statSync(path).isFile() } catch { return false } },
  readdir: (path) => { try { return readdirSync(path) } catch { return [] } },
  configDir: () => '',
}

export function executableName(): string {
  return process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client'
}

export class TunnelClientManager {
  private readonly deps: TunnelManagerDeps
  private readonly adapter = openAiTunnelClientAdapter

  constructor(deps?: Partial<TunnelManagerDeps>) {
    this.deps = { ...DEFAULT_DEPS, ...deps }
  }

  /** PROMA 管理目录：<configDir>/tools/openai-tunnel-client/<version>/<executable> */
  managedRoot(): string {
    return join(this.deps.configDir(), 'tools', 'openai-tunnel-client')
  }

  managedExecutablePath(version: string): string {
    return join(this.managedRoot(), version, executableName())
  }

  /** 用户输入安全校验：拒绝 URL / Shell 元字符（§7/§8） */
  validateExecutableInput(input: string): { ok: true; path: string } | { ok: false; code: string; message: string } {
    const trimmed = input.trim().replace(/^"|"$/g, '')
    if (!trimmed) return { ok: false, code: 'TUNNEL_CLIENT_PATH_INVALID', message: '请填写 OpenAI Tunnel Client 的本地程序位置' }
    if (/^https?:\/\//i.test(trimmed)) {
      return { ok: false, code: 'TUNNEL_CLIENT_PATH_INVALID', message: '这里需要填写本地程序位置，而不是下载地址。如果还没有安装，请使用「安装官方组件」。' }
    }
    if (/[&|><] /.test(trimmed) || /^(cmd|powershell|pwsh)\b/i.test(trimmed)) {
      return { ok: false, code: 'TUNNEL_CLIENT_PATH_INVALID', message: '不支持命令行表达式，请直接选择 tunnel-client 可执行文件本身。' }
    }
    return { ok: true, path: trimmed }
  }

  /** 运行 --version 并解析版本号；status !== 0 或 ENOENT 视为不可用 */
  detectAt(executablePath: string, source: 'managed' | 'custom' | 'system-path'): PromaMcpTunnelDetection {
    if (!this.deps.exists(executablePath)) {
      return { installed: false, source, errorCode: 'TUNNEL_CLIENT_PATH_INVALID', errorMessage: '找不到 OpenAI Tunnel Client：' + executablePath }
    }
    if (!this.deps.isFile(executablePath)) {
      return { installed: false, source, errorCode: 'TUNNEL_CLIENT_PATH_INVALID', errorMessage: '这个位置不是文件：' + executablePath }
    }
    const result = this.deps.spawnSync(executablePath, this.adapter.buildVersionArgs(), { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    if (result.error) {
      // ENOENT / EACCES 等：明确报告，不误判为已安装
      return { installed: false, source, errorCode: 'TUNNEL_CLIENT_PATH_INVALID', errorMessage: '无法运行这个程序（' + (result.error.code ?? result.error.message) + '）。请选择 OpenAI 官方 tunnel-client 可执行文件。' }
    }
    if (result.status !== 0) {
      return { installed: false, source, errorCode: 'TUNNEL_CLIENT_VERSION_UNSUPPORTED', errorMessage: '这个程序可以启动，但不是可用的 OpenAI Tunnel Client（exit ' + result.status + '）。' }
    }
    const version = this.adapter.parseVersion((result.stdout ?? '') + (result.stderr ?? ''))
    // V5 §8：--version 通过只说明是个能跑的程序；必须确认 doctor / run 子命令存在
    // 才算完整 CLI（tunnel-client-runtime.exe 之类的 runtime-only 包在此被拒绝）。
    const doctorHelp = this.deps.spawnSync(executablePath, this.adapter.buildDoctorHelpArgs(), { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    const runHelp = this.deps.spawnSync(executablePath, this.adapter.buildRunHelpArgs(), { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    const fullCli = doctorHelp.status === 0 && runHelp.status === 0
    if (!fullCli) {
      return {
        installed: false,
        executableKind: 'runtime-only',
        source,
        ...(version ? { version } : {}),
        path: executablePath,
        errorCode: 'TUNNEL_CLIENT_VERSION_UNSUPPORTED',
        errorMessage: '这个程序是 OpenAI Tunnel Runtime，不是 PROMA 所需的完整 Tunnel Client CLI（缺少 doctor / run 子命令）。请选择完整 tunnel-client 可执行文件，或使用「安装官方组件」。',
      }
    }
    return { installed: true, executableKind: 'full-cli', path: executablePath, source, ...(version ? { version } : {}) }
  }

  /** 按配置解析当前应使用的程序（custom → managed → system PATH） */
  detect(settings: Pick<PromaMcpTunnelSettings, 'mode' | 'executablePath'>): PromaMcpTunnelDetection {
    const results: PromaMcpTunnelDetection[] = []
    if (settings.mode === 'custom-path' && settings.executablePath) {
      const input = this.validateExecutableInput(settings.executablePath)
      if (!input.ok) {
        return { installed: false, source: 'custom', errorCode: input.code, errorMessage: input.message }
      }
      results.push(this.detectAt(input.path, 'custom'))
    } else if (settings.mode === 'custom-path') {
      return { installed: false, source: 'custom', errorCode: 'TUNNEL_CLIENT_PATH_INVALID', errorMessage: '请先选择 OpenAI Tunnel Client 的本地程序位置' }
    }
    if (settings.mode === 'managed') {
      results.push(this.detectManaged())
    }
    if (settings.mode === 'system-path') {
      results.push(this.detectAt(executableName(), 'system-path'))
    }
    const installed = results.find((r) => r.installed)
    if (installed) return installed
    const first = results[0]
    return first ?? { installed: false, errorCode: 'TUNNEL_CLIENT_NOT_INSTALLED', errorMessage: 'OpenAI Tunnel Client 尚未安装' }
  }

  /** 扫描 managed 目录下全部版本，返回最新可用版本 */
  detectManaged(): PromaMcpTunnelDetection {
    const root = this.managedRoot()
    const versions = this.deps.readdir(root)
      .filter((name) => /^v?\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const version of versions) {
      const detection = this.detectAt(this.managedExecutablePath(version), 'managed')
      if (detection.installed) return detection
    }
    return { installed: false, source: 'managed', errorCode: 'TUNNEL_CLIENT_NOT_INSTALLED', errorMessage: 'OpenAI Tunnel Client 尚未安装' }
  }

  /** 当前已解析程序（快捷方法） */
  resolveExecutable(settings: Pick<PromaMcpTunnelSettings, 'mode' | 'executablePath'>): { path: string; version?: string } | { error: string } {
    const detection = this.detect(settings)
    if (!detection.installed || !detection.path) {
      return { error: detection.errorMessage ?? 'OpenAI Tunnel Client 尚未安装' }
    }
    return { path: detection.path, ...(detection.version ? { version: detection.version } : {}) }
  }
}
