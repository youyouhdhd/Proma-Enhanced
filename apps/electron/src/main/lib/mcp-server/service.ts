/**
 * MCP Server 服务单例（第二轮：Workspace Registry 架构）
 * - 从应用设置读取配置（含多 Workspace 注册表）并启动/停止；
 * - 每次工具调用时按 workspace 条目解析 Agent 工作区 rootPath（不缓存过期路径）；
 * - 对 IPC 暴露状态/启动/停止/更新配置/工具列表。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { PromaMcpServerConfig, PromaMcpServerStatus, PromaMcpToolSummary } from '@proma/shared'
import { getSettings } from '../settings-service'
import { getConfigDir } from '../config-paths'
import { updateSettings } from '../settings-service'
import { getAgentWorkspace, getProjectFilesPath } from '../agent-workspace-manager'
import { normalizePromaMcpServerConfig } from './config'
import { createDefaultLocalToolRegistry, LocalToolRegistry } from '../local-tools/registry'
import type { LocalToolContext } from '../local-tools'
import { buildMcpToolViews } from './tool-adapter'
import { PromaMcpServer } from './server'
import type { WorkspaceDirectoryEntry } from './multi-workspace'
import { mcpSharingStore } from '../mcp-sharing/store'

const registry: LocalToolRegistry = createDefaultLocalToolRegistry()

/** managed-bearer 本机 Secret 的 safeStorage 加密文件路径 */
function localAuthKeyPath(): string {
  return join(getConfigDir(), 'mcp-local-auth-key')
}

/** V6 §29：读取 managed-bearer Secret（safeStorage 解密失败返回 undefined） */
function readManagedLocalAuthToken(): string | undefined {
  const keyPath = localAuthKeyPath()
  if (!existsSync(keyPath)) return undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage } = require('electron') as typeof import('electron')
    if (!safeStorage.isEncryptionAvailable()) return undefined
    return safeStorage.decryptString(Buffer.from(readFileSync(keyPath, 'utf-8'), 'base64'))
  } catch (error) {
    console.error('[MCP Server] 读取本地认证 Secret 失败:', error)
    return undefined
  }
}

/** V6 §29：生成并安全保存 managed-bearer Secret */
function ensureManagedLocalAuthToken(): string {
  const existing = readManagedLocalAuthToken()
  if (existing) return existing
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { safeStorage } = require('electron') as typeof import('electron')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统不支持凭据加密存储，无法启用 PROMA 托管的本机认证')
  }
  const secret = randomBytes(32).toString('hex')
  writeFileSync(localAuthKeyPath(), safeStorage.encryptString(secret).toString('base64'), 'utf-8')
  return secret
}

/**
 * V6 §29 迁移：旧 bearer 配置（settings 明文 token）→ managed-bearer（safeStorage）。
 * 迁移后的 config 只保留 auth.type，不再回写明文 token。
 */
function migrateLocalMcpAuth(current: PromaMcpServerConfig): PromaMcpServerConfig {
  if (current.auth.type === 'bearer' && current.auth.token) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { safeStorage } = require('electron') as typeof import('electron')
      if (safeStorage.isEncryptionAvailable()) {
        writeFileSync(localAuthKeyPath(), safeStorage.encryptString(current.auth.token).toString('base64'), 'utf-8')
        const migrated: PromaMcpServerConfig = { ...current, auth: { type: 'managed-bearer' } }
        updateSettings({ mcpServer: migrated })
        console.log('[MCP Server] 已将本地 Bearer 凭据迁移到系统加密存储')
        return migrated
      }
    } catch (error) {
      console.error('[MCP Server] 本地 Bearer 凭据迁移失败，将按原配置继续:', error)
    }
  }
  return current
}

class PromaMcpServerService {
  private readonly server = new PromaMcpServer()
  private appliedLocal = ''
  private runtimeConfig(): PromaMcpServerConfig {
    const sharing = mcpSharingStore.get()
    return { ...normalizePromaMcpServerConfig(getSettings().mcpServer), enabled: sharing.enabled && sharing.localEndpoint.enabled,
      port: sharing.localEndpoint.port, tools: sharing.tools, auth: { type: sharing.localEndpoint.auth } }
  }
  getLocalMcpAuthToken(config = this.runtimeConfig()): string | undefined {
    return config.auth.type === 'none' ? undefined : readManagedLocalAuthToken()
  }
  async startFromSettings(): Promise<PromaMcpServerStatus> {
    migrateLocalMcpAuth(normalizePromaMcpServerConfig(getSettings().mcpServer))
    const config = this.runtimeConfig()
    if (config.auth.type === 'managed-bearer') ensureManagedLocalAuthToken()
    this.appliedLocal = JSON.stringify(mcpSharingStore.get().localEndpoint)
    return this.server.start({ config, listWorkspaces: () => mcpSharingStore.entries(),
      resolveWorkspaceContext: (id) => {
        const entry = mcpSharingStore.entries().find((e) => e.id === id && e.enabled)
        return entry ? { entry, context: { workspaceId: id, rootPath: entry.rootPath } } : { error: '共享目录不可用或授权已撤销' }
      }, registry, resolveAuthToken: () => this.getLocalMcpAuthToken(config) })
  }
  async syncSharing(): Promise<void> {
    const config = this.runtimeConfig()
    if (!config.enabled) { await this.stop(); return }
    if (!this.server.running || this.appliedLocal !== JSON.stringify(mcpSharingStore.get().localEndpoint)) await this.startFromSettings()
    else this.server.applyToolConfig(config)
  }
  async stop(): Promise<void> { await this.server.stop() }
  startProtocolDebug(): PromaMcpServerStatus { return this.server.startProtocolDebug() }
  getStatus(): PromaMcpServerStatus { return this.server.getStatus() }
  async applyConfig(config: PromaMcpServerConfig): Promise<PromaMcpServerStatus> {
    const normalized = normalizePromaMcpServerConfig(config)
    const sharing = mcpSharingStore.get()
    mcpSharingStore.save({ ...sharing, enabled: normalized.enabled, tools: normalized.tools,
      localEndpoint: { enabled: normalized.enabled, port: normalized.port, auth: normalized.auth.type === 'none' ? 'none' : 'managed-bearer' } })
    await this.syncSharing(); return this.getStatus()
  }
  listTools(): PromaMcpToolSummary[] { return buildMcpToolViews(this.runtimeConfig(), registry).map((t) => ({ name: t.name, description: t.description, risk: t.annotations.readOnlyHint ? 'read' : 'write', enabled: true })) }
}
export const promaMcpServerService = new PromaMcpServerService()
