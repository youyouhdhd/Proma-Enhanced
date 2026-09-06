/*** 
 * OpenAI Secure MCP Tunnel 集成服务（第二轮 P1，规范 §20-§23/§46）
 *
 * 职责：代表用户在本机启动官方 tunnel-client，把 ChatGPT 的 Tunnel 请求
 * 转发到本地 PROMA MCP endpoint。
 *
 * 安全要求（规范 §23）：
 * - Runtime API Key 经 Electron safeStorage 加密后落盘（DPAPI/Keychain），
 *   不进 settings.json、不进命令行参数、不进日志；
 * - 启动 tunnel-client 时通过环境变量 CONTROL_PLANE_API_KEY 注入（官方推荐方式）；
 * - 退出码/stderr 汇总为用户可读消息，绝不包含 Key。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { safeStorage } from 'electron'
import type { PromaMcpTunnelState } from '@proma/shared'
import { getSettings, updateSettings } from '../settings-service'
import { getMcpTunnelKeyPath } from '../config-paths'
import { promaMcpServerService } from './service'

const STARTUP_GRACE_MS = 8_000

class McpTunnelService {
  private child: ChildProcess | null = null
  private state: PromaMcpTunnelState = { status: 'stopped', clientInstalled: false }
  private startupTimer: ReturnType<typeof setTimeout> | null = null

  /** 读取集成配置（tunnelId / clientCommand 存 settings.json，Key 存独立加密文件） */
  getConfig(): { tunnelId?: string; clientCommand?: string } {
    const tunnel = getSettings().mcpTunnel
    return { ...(tunnel?.tunnelId ? { tunnelId: tunnel.tunnelId } : {}), ...(tunnel?.clientCommand ? { clientCommand: tunnel.clientCommand } : {}) }
  }

  saveConfig(config: { tunnelId?: string; clientCommand?: string }): void {
    const current = getSettings().mcpTunnel ?? {}
    updateSettings({
      mcpTunnel: {
        ...current,
        ...(config.tunnelId !== undefined ? { tunnelId: config.tunnelId.trim() || undefined } : {}),
        ...(config.clientCommand !== undefined ? { clientCommand: config.clientCommand.trim() || undefined } : {}),
      },
    })
  }

  /** Runtime API Key：safeStorage 加密落盘；读取只返回解密结果，绝不记录。 */
  saveRuntimeKey(key: string): void {
    const trimmed = key.trim()
    if (!trimmed) return
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统不支持凭据加密存储，无法保存 Runtime API Key')
    }
    const encrypted = safeStorage.encryptString(trimmed)
    writeFileSync(getMcpTunnelKeyPath(), encrypted.toString('base64'), 'utf-8')
  }

  hasRuntimeKey(): boolean {
    return existsSync(getMcpTunnelKeyPath())
  }

  private readRuntimeKey(): string | undefined {
    const keyPath = getMcpTunnelKeyPath()
    if (!existsSync(keyPath) || !safeStorage.isEncryptionAvailable()) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(readFileSync(keyPath, 'utf-8'), 'base64'))
    } catch (error) {
      console.error('[MCP Tunnel] 读取 Runtime API Key 失败:', error)
      return undefined
    }
  }

  clearRuntimeKey(): void {
    const keyPath = getMcpTunnelKeyPath()
    if (existsSync(keyPath)) unlinkSync(keyPath)
  }

  private clientCommand(): string {
    return this.getConfig().clientCommand ?? 'tunnel-client'
  }

  /** tunnel-client 是否可执行（PATH 或用户指定路径） */
  checkInstalled(): boolean {
    const res = spawnSync(this.clientCommand(), ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, shell: process.platform === 'win32' })
    return !res.error
  }

  getState(): PromaMcpTunnelState {
    const tunnelId = this.getConfig().tunnelId
    return {
      ...this.state,
      clientInstalled: this.state.status === 'running' ? true : this.checkInstalled(),
      ...(tunnelId ? { tunnelId } : {}),
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
    }
  }

  /** 启动安全连接：要求本地 MCP 已运行 + Tunnel ID + Runtime Key 已保存。 */
  async start(): Promise<PromaMcpTunnelState> {
    if (this.child) return this.getState()
    const mcpStatus = promaMcpServerService.getStatus()
    if (!mcpStatus.running) {
      this.state = { status: 'error', clientInstalled: this.checkInstalled(), message: '请先启动本地 PROMA MCP 服务' }
      return this.getState()
    }
    const tunnelId = this.getConfig().tunnelId
    if (!tunnelId) {
      this.state = { status: 'error', clientInstalled: this.checkInstalled(), message: '缺少 Tunnel ID（请先在 OpenAI Platform 创建 Secure MCP Tunnel）' }
      return this.getState()
    }
    const runtimeKey = this.readRuntimeKey()
    if (!runtimeKey) {
      this.state = { status: 'error', clientInstalled: this.checkInstalled(), tunnelId, message: '缺少 Runtime API Key（请在下方保存）' }
      return this.getState()
    }
    const command = this.clientCommand()
    this.state = { status: 'starting', clientInstalled: this.checkInstalled(), tunnelId }
    try {
      // Key 只经环境变量注入，绝不进入 argv（进程列表不可见）
      const child = spawn(command, ['--tunnel-id', tunnelId, '--mcp-server-url', mcpStatus.endpoint], {
        env: { ...process.env, CONTROL_PLANE_API_KEY: runtimeKey },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      })
      this.child = child
      // tunnel-client 的运行日志不落盘；stderr 仅用于失败归因，不保存内容
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', () => {})
      child.on('error', (err) => {
        this.state = { status: 'error', clientInstalled: false, ...(tunnelId ? { tunnelId } : {}), message: '无法启动 tunnel-client：' + err.message + '。请确认已安装官方 tunnel-client，或在设置中指定完整路径。' }
        this.child = null
      })
      child.on('close', (code) => {
        if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = null }
        const wasRunning = this.state.status === 'running'
        this.child = null
        if (code === 0 || code === null) {
          this.state = { status: 'stopped', clientInstalled: true, ...(tunnelId ? { tunnelId } : {}) }
        } else {
          this.state = {
            status: 'error',
            clientInstalled: true,
            ...(tunnelId ? { tunnelId } : {}),
            message: (wasRunning ? 'tunnel-client 已退出（code ' + code + '）' : 'tunnel-client 启动失败（code ' + code + '）') + '，可运行诊断查看原因。',
          }
        }
      })
      // 宽限期后仍在运行 → 认为连接建立（精确状态可运行 doctor）
      this.startupTimer = setTimeout(() => {
        if (this.child && this.state.status === 'starting') {
          this.state = { status: 'running', clientInstalled: true, ...(tunnelId ? { tunnelId } : {}) }
        }
      }, STARTUP_GRACE_MS)
      this.startupTimer.unref?.()
    } catch (error) {
      this.state = { status: 'error', clientInstalled: this.checkInstalled(), ...(tunnelId ? { tunnelId } : {}), message: error instanceof Error ? error.message : String(error) }
    }
    return this.getState()
  }

  stop(): PromaMcpTunnelState {
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = null }
    if (this.child) {
      this.child.kill()
      this.child = null
    }
    this.state = { status: 'stopped', clientInstalled: this.checkInstalled(), ...(this.getConfig().tunnelId ? { tunnelId: this.getConfig().tunnelId } : {}) }
    return this.getState()
  }

  /** 运行官方诊断命令（tunnel-client doctor），返回用户可读输出。 */
  async doctor(): Promise<{ ok: boolean; output: string }> {
    const command = this.clientCommand()
    const tunnelId = this.getConfig().tunnelId
    const args = ['doctor', ...(tunnelId ? ['--tunnel-id', tunnelId] : [])]
    return new Promise<{ ok: boolean; output: string }>((resolve) => {
      const child = spawn(command, args, { windowsHide: true, shell: process.platform === 'win32' })
      let out = ''
      child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
      child.on('error', (err) => resolve({ ok: false, output: '无法运行 tunnel-client doctor：' + err.message }))
      child.on('close', (code) => resolve({ ok: code === 0, output: out.slice(0, 8000) || '（无输出）' }))
    })
  }
}

export const mcpTunnelService = new McpTunnelService()
