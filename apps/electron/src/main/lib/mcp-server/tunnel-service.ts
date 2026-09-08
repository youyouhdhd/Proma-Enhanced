/**
 * McpTunnelService — OpenAI Secure MCP Tunnel 生命周期（第三轮重构）
 *
 * 目标（规范 §19-§24/§65）：
 * - 删除「进程存活 8 秒 = 已连接」启发式；以真实 /healthz → /readyz 为准；
 * - 状态机 phase 全程推进并实时推送（mcp-tunnel:state-changed），杜绝渲染层永久 starting；
 * - 进程一律 shell:false 直接 spawn（Windows 不经 cmd.exe，无乱码、命令缺失得到 ENOENT）；
 * - CLI 参数统一由 Adapter 构造；Runtime API Key 只经环境变量注入，不进 argv / 日志；
 * - 旧 clientCommand 配置一次性迁移到 mode / executablePath（§9）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { PromaMcpConnectorDiagnosis, PromaMcpTunnelDetection, PromaMcpTunnelDoctorResult, PromaMcpTunnelPhase, PromaMcpTunnelSettings, PromaMcpTunnelState } from '@proma/shared'
import { getSettings, updateSettings } from '../settings-service'
import { getConfigDir } from '../config-paths'
import { promaMcpServerService } from './service'
import { TunnelClientManager } from './tunnel-client-manager'
import { TunnelClientInstaller } from './tunnel-client-installer'
import { classifyClientFailure, openAiTunnelClientAdapter } from './tunnel-client-adapter'
import { TunnelProcessRunner } from './tunnel-process-runner'
import { classifyConnectorConclusion } from './tunnel-doctor-parser'
import { computeMethodStats } from './protocol/request-trace'
import type { TunnelRuntimeConfig } from './tunnel-client-types'

const READY_POLL_INTERVAL_MS = 1_000
const READY_TIMEOUT_MS = 60_000
const HEALTH_URL_FILE_POLL_MS = 500
const HEALTH_URL_FILE_TIMEOUT_MS = 20_000

const STOPPED_STATE: PromaMcpTunnelState = {
  phase: 'stopped',
  client: { installed: false },
  localMcpReady: false,
  runtimeKeyConfigured: false,
}

function defaultTunnelSettings(): PromaMcpTunnelSettings {
  return { mode: 'managed' }
}

class McpTunnelService {
  private state: PromaMcpTunnelState = { ...STOPPED_STATE }
  private child: ReturnType<typeof spawn> | null = null
  private healthUrlFile: string | null = null
  private workDir: string | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<(state: PromaMcpTunnelState) => void>()
  private readonly manager = new TunnelClientManager({ configDir: () => getConfigDir() })
  private readonly installer = new TunnelClientInstaller(this.manager, { configDir: () => getConfigDir() })
  private readonly adapter = openAiTunnelClientAdapter
  private readonly runner = new TunnelProcessRunner()

  onStateChanged(listener: (state: PromaMcpTunnelState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ===== 配置（含旧 clientCommand 一次性迁移，规范 §9） =====

  getConfig(): PromaMcpTunnelSettings {
    const raw = getSettings().mcpTunnel
    const migrated = this.migrateLegacy(raw)
    return migrated
  }

  private migrateLegacy(raw?: Partial<PromaMcpTunnelSettings>): PromaMcpTunnelSettings {
    if (!raw) return defaultTunnelSettings()
    const legacyCommand = raw.clientCommand
    const base: PromaMcpTunnelSettings = {
      ...defaultTunnelSettings(),
      ...(raw.tunnelId ? { tunnelId: raw.tunnelId } : {}),
      ...(raw.mode ? { mode: raw.mode } : {}),
      ...(raw.executablePath ? { executablePath: raw.executablePath } : {}),
      ...(raw.autoConnect !== undefined ? { autoConnect: raw.autoConnect } : {}),
    }
    if (!legacyCommand || raw.mode) return base
    // 绝不把旧的自定义命令行继续当 Shell 执行（§9）
    if (/[&|><]/.test(legacyCommand) || /^(cmd|powershell|pwsh)\b/i.test(legacyCommand.trim())) {
      return { ...base, mode: 'managed' }
    }
    const looksLikePath = /[\\/]\.?[a-z]*$/i.test(legacyCommand) && !/^[a-z0-9-]+$/i.test(legacyCommand)
    if (looksLikePath) {
      const migrated = { ...base, mode: 'custom-path' as const, executablePath: legacyCommand }
      this.persistConfig(migrated)
      return migrated
    }
    if (legacyCommand.trim() === 'tunnel-client' || legacyCommand.trim() === 'tunnel-client.exe') {
      const migrated = { ...base, mode: 'system-path' as const }
      this.persistConfig(migrated)
      return migrated
    }
    return { ...base, mode: 'managed' }
  }

  private persistConfig(settings: PromaMcpTunnelSettings): void {
    updateSettings({ mcpTunnel: { ...settings, clientCommand: undefined } })
  }

  saveConfig(config: Partial<PromaMcpTunnelSettings>): PromaMcpTunnelState {
    const current = this.getConfig()
    const next: PromaMcpTunnelSettings = {
      ...current,
      ...config,
      ...(config.tunnelId !== undefined ? { tunnelId: config.tunnelId.trim() || undefined } : {}),
      ...(config.executablePath !== undefined ? { executablePath: config.executablePath.trim() || undefined } : {}),
    }
    this.persistConfig(next)
    // 配置变化立即刷新 client 信息与阶段（不自动连接）
    const detection = this.manager.detect(next)
    this.state = {
      ...this.state,
      client: this.clientInfoFrom(detection),
      tunnelId: next.tunnelId,
      ...(this.state.phase === 'connected' || this.state.phase === 'starting' || this.state.phase === 'waiting-ready' ? {} : { phase: this.idlePhaseFor(detection) }),
    }
    this.emit()
    return this.state
  }

  private idlePhaseFor(detection: PromaMcpTunnelDetection): PromaMcpTunnelPhase {
    if (!detection.installed) return 'not-installed'
    const config = this.getConfig()
    if (!config.tunnelId || !this.hasRuntimeKey() || !promaMcpServerService.getStatus().running) return 'needs-config'
    return 'stopped'
  }

  // ===== Runtime API Key（safeStorage，规范 §18 保留） =====

  saveRuntimeKey(key: string): void {
    const { safeStorage } = require('electron') as typeof import('electron')
    const trimmed = key.trim()
    if (!trimmed) return
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统不支持凭据加密存储，无法保存 Runtime API Key')
    }
    const configDir = getConfigDir()
    writeFileSync(join(configDir, 'mcp-tunnel-key'), safeStorage.encryptString(trimmed).toString('base64'), 'utf-8')
    // V6 §7：写入后回读验证（roundtrip 绝不打日志），凭据状态以存储为事实来源
    const roundTrip = this.readRuntimeKey()
    if (roundTrip !== trimmed) {
      throw new Error('Runtime API Key 保存验证失败')
    }
    this.emit()
  }

  hasRuntimeKey(): boolean {
    return existsSync(join(getConfigDir(), 'mcp-tunnel-key'))
  }

  /** V6 §8：清除已保存的 Runtime API Key（UI 二次确认后调用），状态立即派生刷新 */
  clearRuntimeKey(): PromaMcpTunnelState {
    const keyPath = join(getConfigDir(), 'mcp-tunnel-key')
    if (existsSync(keyPath)) unlinkSync(keyPath)
    this.emit()
    return this.getState()
  }

  /** V6 §26：凭据健康三态（文件存在但解密失败 = unreadable，不得显示绿色） */
  getRuntimeKeyStatus(): 'missing' | 'available' | 'unreadable' {
    if (!this.hasRuntimeKey()) return 'missing'
    return this.readRuntimeKey() !== undefined ? 'available' : 'unreadable'
  }

  private readRuntimeKey(): string | undefined {
    const keyPath = join(getConfigDir(), 'mcp-tunnel-key')
    if (!existsSync(keyPath)) return undefined
    try {
      const { safeStorage } = require('electron') as typeof import('electron')
      if (!safeStorage.isEncryptionAvailable()) return undefined
      return safeStorage.decryptString(Buffer.from(readFileSync(keyPath, 'utf-8'), 'base64'))
    } catch (error) {
      console.error('[MCP Tunnel] 读取 Runtime API Key 失败:', error)
      return undefined
    }
  }

  // ===== 状态 =====

  getState(): PromaMcpTunnelState {
    return this.buildStateSnapshot()
  }

  /**
   * V6 §6：状态快照派生——runtimeKeyConfigured / runtimeKeyStatus / localMcpReady
   * 以凭据存储与 MCP Server 实际状态为事实来源，不再依赖散落赋值。
   */
  private buildStateSnapshot(): PromaMcpTunnelState {
    const keyStatus = this.getRuntimeKeyStatus()
    return {
      ...this.state,
      runtimeKeyConfigured: keyStatus === 'available',
      runtimeKeyStatus: keyStatus,
      localMcpReady: promaMcpServerService.getStatus().running,
    }
  }

  /** 刷新当前 client 检测结果（GET_STATE / 检测按钮） */
  async detectClient(): Promise<PromaMcpTunnelDetection> {
    const detection = this.manager.detect(this.getConfig())
    this.state = {
      ...this.state,
      client: this.clientInfoFrom(detection),
      ...(this.isIdlePhase(this.state.phase) ? { phase: this.idlePhaseFor(detection) } : {}),
    }
    this.emit()
    return detection
  }

  async installClient(): Promise<PromaMcpTunnelDetection> {
    this.emit() // UI 可立即显示安装中
    const detection = await this.installer.install()
    this.state = { ...this.state, client: this.clientInfoFrom(detection), ...(detection.installed ? { phase: this.idlePhaseFor(detection) } : {}) }
    this.emit()
    return detection
  }

  private clientInfoFrom(detection: PromaMcpTunnelDetection): PromaMcpTunnelState['client'] {
    return {
      installed: detection.installed,
      ...(detection.path ? { path: detection.path } : {}),
      ...(detection.version ? { version: detection.version } : {}),
      ...(detection.source ? { source: detection.source } : {}),
      ...(detection.errorCode ? { errorCode: detection.errorCode } : {}),
      ...(detection.errorMessage ? { errorMessage: detection.errorMessage } : {}),
    }
  }

  private isIdlePhase(phase: PromaMcpTunnelPhase): boolean {
    return phase === 'not-installed' || phase === 'needs-config' || phase === 'stopped' || phase === 'error'
  }

  // ===== 启动 / 停止（真实 readiness） =====

  async start(): Promise<PromaMcpTunnelState> {
    if (this.child) return this.state
    const settings = this.getConfig()

    // Preflight 1：本地 MCP
    this.setPhase('preflight')
    const mcpStatus = promaMcpServerService.getStatus()
    if (!mcpStatus.running) {
      return this.fail('LOCAL_MCP_NOT_RUNNING', '请先启动本地 PROMA MCP 服务（步骤 2）。', '打开本页步骤 2 并启动')
    }
    // Preflight 2：Tunnel Client
    const detection = this.manager.detect(settings)
    this.state = { ...this.state, client: this.clientInfoFrom(detection) }
    if (!detection.installed || !detection.path) {
      return this.fail('TUNNEL_CLIENT_NOT_INSTALLED', detection.errorMessage ?? 'OpenAI Tunnel Client 尚未安装，请先安装或选择本机程序。', '安装官方组件或选择已有程序')
    }
    // Preflight 3：Tunnel ID
    const tunnelId = settings.tunnelId?.trim()
    if (!tunnelId) {
      return this.fail('TUNNEL_ID_MISSING', '缺少 Tunnel ID。请到 OpenAI Platform 创建 Secure MCP Tunnel 并把 Tunnel ID 粘贴到这里。', '完成步骤 4')
    }
    if (!/^tunnel_[\w-]+$/.test(tunnelId)) {
      return this.fail('TUNNEL_ID_INVALID', 'Tunnel ID 格式不正确，应以 tunnel_ 开头。请回到 OpenAI Platform 核对。', '重新填写 Tunnel ID')
    }
    // Preflight 4：Runtime Key
    const runtimeKey = this.readRuntimeKey()
    if (!runtimeKey) {
      return this.fail('RUNTIME_KEY_MISSING', '缺少 Runtime API Key。请到 OpenAI Platform 创建后在本页安全保存。', '完成步骤 5')
    }

    // 启动：health URL 文件 + spawn（shell:false）
    this.phase('starting')
    this.workDir = mkdtempSync(join(tmpdir(), 'proma-tunnel-run-'))
    this.healthUrlFile = join(this.workDir, 'health-url.txt')
    writeFileSync(this.healthUrlFile, '', 'utf-8')
    const runtime: TunnelRuntimeConfig = {
      tunnelId,
      mcpServerUrl: mcpStatus.endpoint,
      healthListenAddr: '127.0.0.1:0',
      healthUrlFile: this.healthUrlFile,
    }
    // V6 §14：Local MCP 本机认证 → tunnel-client 经 env 引用注入 Authorization（doctor/run 一致）
    const localToken = promaMcpServerService.getLocalMcpAuthToken()
    if (localToken) {
      runtime.localMcpAuth = { type: 'bearer', envVarName: 'PROMA_MCP_AUTH_HEADER' }
    }
    const args = this.adapter.buildRunArgs(runtime)
    try {
      const child = spawn(detection.path, args, {
        env: this.runner.buildTunnelClientEnv({ runtimeKey, ...(localToken ? { localMcpBearerToken: localToken } : {}) }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // shell 必须为 false：Windows 不经 cmd.exe（§12/§14）
        shell: false,
      })
      this.child = child
      this.state = { ...this.state, pid: child.pid }
      const stderrTail: string[] = []
      const collect = (decoder: StringDecoder) => (chunk: Buffer) => {
        // UTF-8 跨 Buffer 安全解码；仅保留尾部用于失败归因，不落盘
        const text = decoder.write(chunk)
        stderrTail.push(text)
        if (stderrTail.length > 50) stderrTail.shift()
      }
      child.stdout?.on('data', collect(new StringDecoder('utf8')))
      child.stderr?.on('data', collect(new StringDecoder('utf8')))
      child.on('error', (err) => {
        this.child = null
        this.fail('TUNNEL_CLIENT_LAUNCH_FAILED', '无法启动 OpenAI Tunnel Client（' + err.message + '）。请重新检测程序或重新安装。', '重新检测程序')
      })
      child.on('close', (code) => {
        const wasRunning = this.state.phase === 'connected'
        this.child = null
        this.cleanupTemp()
        if (this.state.phase === 'stopping') {
          this.state = { ...STOPPED_STATE, client: this.state.client, tunnelId: this.state.tunnelId, runtimeKeyConfigured: this.hasRuntimeKey(), localMcpReady: promaMcpServerService.getStatus().running }
          this.emit()
          return
        }
        const failure = classifyClientFailure(stderrTail.join(''))
        this.fail(
          failure?.code ?? 'TUNNEL_CLIENT_EXITED',
          wasRunning
            ? '安全连接已断开（OpenAI Tunnel Client 退出，code ' + code + '）。可重新连接。'
            : (failure?.title ?? 'OpenAI Tunnel Client 提前退出（code ' + code + '）。可运行诊断查看原因。'),
          failure?.action ?? '重新连接或运行诊断',
        )
      })
    } catch (error) {
      return this.fail('TUNNEL_CLIENT_LAUNCH_FAILED', '无法启动 OpenAI Tunnel Client：' + (error instanceof Error ? error.message : String(error)), '重新检测程序')
    }

    // 等待健康 URL 文件被写入 → /healthz → /readyz
    this.phase('waiting-ready')
    void this.waitUntilReady()
    return this.state
  }

  private async waitUntilReady(): Promise<void> {
    const startedAt = Date.now()
    let healthUrl: string | undefined
    while (Date.now() - startedAt < HEALTH_URL_FILE_TIMEOUT_MS) {
      if (!this.child) return // 进程已退出，close 处理器负责
      try {
        const content = this.healthUrlFile && existsSync(this.healthUrlFile) ? readFileSync(this.healthUrlFile, 'utf-8').trim() : ''
        if (content) { healthUrl = content; break }
      } catch { /* 文件尚未写入 */ }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_URL_FILE_POLL_MS))
    }
    if (!healthUrl && this.healthUrlFile && existsSync(this.healthUrlFile)) {
      // 某些版本不写文件而直接监听固定端口；兜底读 stdout 不可行（已丢弃），以超时为准
    }
    if (!healthUrl) {
      if (this.child) {
        this.fail('READY_TIMEOUT', '等待安全连接准备超时。可运行诊断查看原因，或稍后重试。', '运行诊断')
      }
      return
    }
    this.state = { ...this.state, healthUrl }
    this.emit()

    const readyStartedAt = Date.now()
    while (Date.now() - readyStartedAt < READY_TIMEOUT_MS) {
      if (!this.child) return
      try {
        // /healthz = 进程活着；/readyz = Tunnel + MCP 就绪（§20）
        await fetch(new URL('/healthz', healthUrl), { signal: AbortSignal.timeout(2_000) })
        const ready = await fetch(new URL('/readyz', healthUrl), { signal: AbortSignal.timeout(2_000) })
        if (ready.status === 200) {
          this.state = { ...this.state, phase: 'connected', lastConnectedAt: Date.now(), error: undefined }
          this.emit()
          return
        }
      } catch { /* 尚未就绪，继续轮询 */ }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS))
    }
    if (this.child) {
      this.fail('READY_TIMEOUT', '安全连接在超时时间内未就绪。可运行诊断查看原因。', '运行诊断')
    }
  }

  stop(): PromaMcpTunnelState {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
    this.phase('stopping')
    if (this.child) {
      this.child.kill()
      this.child = null
    }
    this.cleanupTemp()
    this.state = { ...STOPPED_STATE, client: this.state.client, tunnelId: this.getConfig().tunnelId, runtimeKeyConfigured: this.hasRuntimeKey(), localMcpReady: promaMcpServerService.getStatus().running }
    this.emit()
    return this.state
  }

  // ===== 诊断（结构化，§35/§36） =====

  async doctor(): Promise<PromaMcpTunnelDoctorResult> {
    const settings = this.getConfig()
    const resolved = this.manager.resolveExecutable(settings)
    if ('error' in resolved) {
      return {
        ok: false,
        checks: [{ name: 'OpenAI Tunnel Client', state: 'fail', ok: false, message: resolved.error }],
        technical: { stdout: '', stderr: '' },
      }
    }
    // TC-V5-KEY-01：Key 未配置时不启动 Doctor 子进程，直接返回明确诊断
    const runtimeKey = this.readRuntimeKey()
    if (!runtimeKey) {
      return {
        ok: false,
        checks: [
          { name: 'OpenAI Tunnel Client', state: 'pass', ok: true, ...(resolved.version ? { message: resolved.version } : {}) },
          { name: 'Runtime API Key', state: 'fail', ok: false, message: '尚未保存 Runtime API Key。请先完成步骤 5。' },
          { name: 'Tunnel 配置', state: 'unknown', ok: false, message: '未完成验证' },
          { name: 'OpenAI 网络', state: 'unknown', ok: false, message: '未完成验证' },
          { name: 'PROMA MCP', state: 'unknown', ok: false, message: '未完成完整 Tunnel 验证' },
          { name: 'Secure Tunnel Ready', state: 'unknown', ok: false, message: '未完成完整 Tunnel 验证' },
        ],
        technical: { stdout: '', stderr: '', ...(resolved.version ? { version: resolved.version } : {}) },
      }
    }
    const mcpStatus = promaMcpServerService.getStatus()
    // V6 §14/§16：Local MCP 开启本机认证时，doctor 与 run 注入同一凭据
    const localToken = promaMcpServerService.getLocalMcpAuthToken()
    const runtime: TunnelRuntimeConfig = {
      tunnelId: settings.tunnelId ?? '',
      mcpServerUrl: mcpStatus.endpoint || 'http://127.0.0.1:0/mcp',
      healthListenAddr: '127.0.0.1:0',
      healthUrlFile: join(tmpdir(), 'proma-tunnel-doctor-' + Date.now() + '.txt'),
      ...(localToken ? { localMcpAuth: { type: 'bearer' as const, envVarName: 'PROMA_MCP_AUTH_HEADER' } } : {}),
    }
    try {
      // V5 §4：doctor 与 run 使用同一个 buildTunnelClientEnv——凭据只经环境变量注入
      const captured = await this.runner.runCapture(resolved.path, this.adapter.buildDoctorArgs(runtime), {
        runtimeKey,
        ...(localToken ? { localMcpBearerToken: localToken } : {}),
        timeoutMs: 120_000,
      })
      const result = this.runner.redact(captured, runtimeKey, localToken)
      return this.adapter.parseDoctor({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }, resolved.version)
    } finally {
      // V6 §9：Doctor 临时文件成功 / 失败 / 超时 / spawn error 都要清理
      try { if (existsSync(runtime.healthUrlFile)) unlinkSync(runtime.healthUrlFile) } catch { /* 清理失败不影响诊断 */ }
    }
  }

  /**
   * ChatGPT Connector 创建失败端到端诊断（V5 §13）：
   * 逐层验证 本地 MCP → 完整 CLI → Key → Doctor → /readyz → 最近 MCP 请求 →
   * tools/list 状态，并归类为 CASE A / B / C。
   */
  async diagnoseConnector(windowStartedAt?: number): Promise<PromaMcpConnectorDiagnosis> {
    const checks: PromaMcpConnectorDiagnosis['checks'] = []
    const mcpStatus = promaMcpServerService.getStatus()
    // 1. Local MCP running
    checks.push({ name: '本地 PROMA MCP', state: mcpStatus.running ? 'pass' : 'fail', message: mcpStatus.running ? '已运行' : '未运行（请完成步骤 2）' })
    // 2. Local MCP /health
    if (mcpStatus.running) {
      try {
        const health = await fetch(new URL('/health', mcpStatus.endpoint), { signal: AbortSignal.timeout(2_000) })
        checks.push({ name: '本地 MCP /health', state: health.ok ? 'pass' : 'fail', message: 'HTTP ' + health.status })
      } catch (error) {
        checks.push({ name: '本地 MCP /health', state: 'fail', message: error instanceof Error ? error.message : '无法访问' })
      }
    } else {
      checks.push({ name: '本地 MCP /health', state: 'skipped', message: '本地 MCP 未运行' })
    }
    // 3. 完整 tunnel-client CLI
    const detection = this.manager.detect(this.getConfig())
    checks.push({
      name: 'OpenAI Tunnel Client（完整 CLI）',
      state: detection.installed && detection.executableKind === 'full-cli' ? 'pass' : 'fail',
      message: detection.installed
        ? (detection.executableKind === 'full-cli' ? (detection.version ?? '已检测') : '这是 runtime-only 包，需要完整 CLI')
        : (detection.errorMessage ?? '未安装'),
    })
    // 4. Runtime Key
    const keyConfigured = this.hasRuntimeKey()
    checks.push({ name: 'Runtime API Key', state: keyConfigured ? 'pass' : 'fail', message: keyConfigured ? '已安全保存' : '尚未保存（请完成步骤 5）' })
    // 5. Doctor
    let doctorOk = false
    let doctorMcpReachableMessage: string | undefined
    if (detection.installed && keyConfigured && mcpStatus.running) {
      const doctor = await this.doctor()
      // V6 §25：阻断 Connector 的是关键检查失败（codex_plugin / ui SKIP 不算）
      doctorOk = doctor.ok && (doctor.blockingFailures?.length ?? 0) === 0
      const reachable = doctor.checks.find((c) => c.name === 'PROMA MCP 可达性')
      doctorMcpReachableMessage = reachable?.message
      for (const check of doctor.checks) {
        if (check.state !== 'pass') {
          checks.push({ name: 'Doctor · ' + check.name, state: check.state, message: check.message })
        }
      }
      checks.push({ name: 'Doctor 诊断', state: doctor.ok ? 'pass' : 'fail', message: doctor.ok ? 'exit 0' : '存在失败项（见上）' })
    } else {
      checks.push({ name: 'Doctor 诊断', state: 'skipped', message: '前置条件未满足' })
    }
    // 6. /readyz
    if (this.state.phase === 'connected') {
      checks.push({ name: 'Secure Tunnel /readyz', state: 'pass', message: 'HTTP 200' })
    } else if (this.state.healthUrl) {
      try {
        const ready = await fetch(new URL('/readyz', this.state.healthUrl), { signal: AbortSignal.timeout(2_000) })
        checks.push({ name: 'Secure Tunnel /readyz', state: ready.status === 200 ? 'pass' : 'fail', message: 'HTTP ' + ready.status })
      } catch (error) {
        checks.push({ name: 'Secure Tunnel /readyz', state: 'fail', message: error instanceof Error ? error.message : '无法访问' })
      }
    } else {
      checks.push({ name: 'Secure Tunnel /readyz', state: 'unknown', message: 'Tunnel 未启动' })
    }
    // 7-9. 最近 MCP 请求 / tools/list
    const windowStart = windowStartedAt ?? (Date.now() - 5 * 60 * 1000)
    const recent = mcpStatus.recentRequests.filter((r) => r.at >= windowStart)
    checks.push({ name: '诊断窗口内收到 MCP 请求', state: recent.length > 0 ? 'pass' : 'unknown', message: recent.length > 0 ? recent.length + ' 条' : '未收到任何请求' })
    const toolsList = recent.filter((r) => r.jsonRpcMethod === 'tools/list')
    checks.push({ name: 'tools/list 请求', state: toolsList.length > 0 ? (toolsList.some((r) => r.statusCode === 200) ? 'pass' : 'fail') : 'unknown', message: toolsList.length > 0 ? toolsList.map((r) => r.statusCode).join(', ') : '未收到 tools/list' })

    // V6 §17：HTTP 401/403 是 PROMA 语义错误，不只是「可达」
    const reachableMessage = doctorMcpReachableMessage ?? ''
    if (reachableMessage.includes('401')) {
      checks.push({ name: 'PROMA MCP 内部认证', state: 'fail', message: 'Tunnel Client 已能访问本地 MCP 地址，但 PROMA 返回 HTTP 401：Tunnel Client 没有携带本机凭据或凭据不匹配。' })
    } else if (reachableMessage.includes('403')) {
      checks.push({ name: 'PROMA MCP 内部认证', state: 'fail', message: 'PROMA 返回 HTTP 403：本机凭据被拒绝。' })
    } else if (doctorMcpReachableMessage) {
      checks.push({ name: 'PROMA MCP 内部认证', state: 'pass', message: promaMcpServerService.getLocalMcpAuthToken() !== undefined ? 'Tunnel Client 已正确携带本机凭据' : '未启用本机认证（localhost-only）' })
    }

    const conclusion = classifyConnectorConclusion({
      recentCount: recent.length,
      allRejected: recent.every((r) => r.authResult === 'rejected' || r.statusCode === 401 || r.statusCode === 403),
      discoverCount: recent.filter((r) => r.jsonRpcMethod === 'server/discover').length,
      discoverOk: recent.some((r) => r.jsonRpcMethod === 'server/discover' && r.statusCode === 200 && !r.rpcErrorCode),
      toolsListCount: toolsList.length,
      toolsListOk: toolsList.some((r) => r.statusCode === 200),
      doctorOk,
    })
    return { generatedAt: Date.now(), windowStartedAt: windowStart, checks, conclusion, stats: computeMethodStats(recent) }
  }

  // ===== 内部 =====

  private setPhase(phase: PromaMcpTunnelPhase): void {
    this.state = { ...this.state, phase }
    this.emit()
  }

  private phase(phase: PromaMcpTunnelPhase): void {
    this.setPhase(phase)
  }

  private fail(code: string, title: string, action?: string): PromaMcpTunnelState {
    this.state = { ...this.state, phase: 'error', error: { code, title, ...(action ? { action } : {}) } }
    this.emit()
    return this.state
  }

  private cleanupTemp(): void {
    if (this.workDir && existsSync(this.workDir)) rmSync(this.workDir, { recursive: true, force: true })
    this.workDir = null
    this.healthUrlFile = null
  }

  private emit(): void {
    // V6 §6.1：emit 同样使用派生快照，订阅者看到的凭据状态永远是最新事实
    this.state = this.buildStateSnapshot()
    for (const listener of this.listeners) {
      try { listener(this.state) } catch (err) { console.error('[MCP Tunnel] 状态监听器异常:', err) }
    }
  }
}

export const mcpTunnelService = new McpTunnelService()
