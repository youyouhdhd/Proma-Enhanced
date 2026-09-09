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
import { createConfiguredTools, PUBLIC_READONLY_TOOLS } from './configured-tools'

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

/** 从配置条目解析一个可用 Workspace 目录（Agent 工作区存在 + 根目录有效） */
function resolveWorkspaceEntry(config: PromaMcpServerConfig, entryId: string): WorkspaceDirectoryEntry {
  const entry = config.workspaces.find((w) => w.id === entryId)
  if (!entry) throw new Error('MCP Workspace 条目不存在: ' + entryId)
  if (!entry.enabled) throw new Error('MCP Workspace 未启用: ' + entryId)
  const workspace = getAgentWorkspace(entry.agentWorkspaceId)
  const rootPath = workspace?.projectRootPath ?? (workspace?.slug ? getProjectFilesPath(workspace.slug) : '')
  if (!rootPath || !existsSync(rootPath)) {
    throw new Error('MCP Workspace 根目录不可用：' + (entry.name ?? entry.agentWorkspaceId))
  }
  return {
    id: entry.id,
    name: entry.name ?? workspace?.name ?? entry.agentWorkspaceId,
    rootPath,
    enabled: true,
    permissions: entry.permissions,
  }
}

/** 列出配置注册的全部 Workspace（含未启用；可用性按当前 Agent 工作区状态判定） */
function listWorkspaceEntries(config: PromaMcpServerConfig): WorkspaceDirectoryEntry[] {
  return config.workspaces.map((entry) => {
    const workspace = getAgentWorkspace(entry.agentWorkspaceId)
    const rootPath = workspace?.projectRootPath ?? (workspace?.slug ? getProjectFilesPath(workspace.slug) : '')
    const available = Boolean(rootPath && existsSync(rootPath))
    return {
      id: entry.id,
      name: entry.name ?? workspace?.name ?? entry.agentWorkspaceId,
      ...(rootPath && available ? { rootPath } : {}),
      enabled: entry.enabled && available,
      permissions: entry.permissions,
    } as WorkspaceDirectoryEntry
  })
}

function workspaceContext(entry: WorkspaceDirectoryEntry): { context: LocalToolContext; entry: WorkspaceDirectoryEntry } {
  return {
    context: { workspaceId: entry.id, rootPath: entry.rootPath },
    entry,
  }
}

class PromaMcpServerService {
  private readonly server = new PromaMcpServer()
  hasPublicWorkspace(workspaceIds: string[]): boolean {
    return listWorkspaceEntries(normalizePromaMcpServerConfig(getSettings().mcpServer)).some((e) => e.enabled && e.permissions.read && workspaceIds.includes(e.id))
  }

  /** Public scope 与内部启用/read 权限取交集，每次调用重新解析目录。 */
  publicTools(workspaceIds: string[]) {
    const config = () => normalizePromaMcpServerConfig(getSettings().mcpServer)
    return createConfiguredTools({
      config: () => ({ ...config(), accessMode: 'read-only', tools: { fileRead: true, search: true, git: true, fileWrite: false, shell: false } }),
      entries: () => listWorkspaceEntries(config()).filter((e) => workspaceIds.includes(e.id) && e.permissions.read)
        .map((e) => ({ ...e, permissions: { read: true, write: false, shell: false } })),
      resolve: (id) => {
        try {
          const entry = resolveWorkspaceEntry(config(), id)
          if (!workspaceIds.includes(id) || !entry.permissions.read) return { error: '项目没有公网读取授权' }
          return workspaceContext({ ...entry, permissions: { read: true, write: false, shell: false } })
        } catch { return { error: '项目不可用或读取授权已撤销' } }
      }, registry, allowedNames: PUBLIC_READONLY_TOOLS,
    })
  }

  /** V6 §12：解析 Local MCP 生效的 Bearer token（managed-bearer → safeStorage；bearer → 配置） */
  getLocalMcpAuthToken(config?: PromaMcpServerConfig): string | undefined {
    const effective = config ?? normalizePromaMcpServerConfig(getSettings().mcpServer)
    if (effective.auth.type === 'managed-bearer') return readManagedLocalAuthToken()
    if (effective.auth.type === 'bearer') return effective.auth.token
    return undefined
  }

  /** 按当前设置启动（设置未启用或未授权任何项目时抛错） */
  async startFromSettings(): Promise<PromaMcpServerStatus> {
    const settings = getSettings()
    const config = migrateLocalMcpAuth(normalizePromaMcpServerConfig(settings.mcpServer))
    // managed-bearer 需要 Secret 就绪（首次启用时生成）
    if (config.auth.type === 'managed-bearer') ensureManagedLocalAuthToken()
    if (config.enabled && config.workspaces.filter((w) => w.enabled).length === 0) {
      throw new Error('MCP Server 尚未授权任何项目，请先在设置中选择要共享的 Workspace。')
    }
    return this.server.start({
      config,
      listWorkspaces: () => listWorkspaceEntries(config),
      resolveWorkspaceContext: (entryId) => {
        try {
          const entry = resolveWorkspaceEntry(config, entryId)
          return workspaceContext(entry)
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
      registry,
      resolveAuthToken: () => this.getLocalMcpAuthToken(config),
    })
  }

  async stop(): Promise<void> {
    await this.server.stop()
  }

  startProtocolDebug(): PromaMcpServerStatus {
    return this.server.startProtocolDebug()
  }

  getStatus(): PromaMcpServerStatus {
    return this.server.getStatus()
  }

  /** 更新配置并按需启动/停止/重启 */
  async applyConfig(config: PromaMcpServerConfig): Promise<PromaMcpServerStatus> {
    const normalized = normalizePromaMcpServerConfig(config)
    const migrated = migrateLocalMcpAuth(normalized)
    if (migrated.auth.type === 'managed-bearer') ensureManagedLocalAuthToken()
    const wasRunning = this.server.running
    if (wasRunning) await this.server.stop()
    if (migrated.enabled) {
      if (migrated.workspaces.filter((w) => w.enabled).length === 0) {
        throw new Error('MCP Server 尚未授权任何项目，请先在设置中选择要共享的 Workspace。')
      }
      return this.server.start({
        config: migrated,
        listWorkspaces: () => listWorkspaceEntries(migrated),
        resolveWorkspaceContext: (entryId) => {
          try {
            const entry = resolveWorkspaceEntry(migrated, entryId)
            return workspaceContext(entry)
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
          }
        },
        registry,
        resolveAuthToken: () => this.getLocalMcpAuthToken(migrated),
      })
    }
    return this.getStatus()
  }

  listTools(): PromaMcpToolSummary[] {
    const settings = getSettings()
    const config = normalizePromaMcpServerConfig(settings.mcpServer)
    const views = buildMcpToolViews(config, registry)
    const visible = new Set(views.map((view) => view.name))
    // 摘要合并 registry 工具 + 多工作区固定工具
    const seen = new Set<string>()
    const summaries: PromaMcpToolSummary[] = []
    for (const view of views) {
      if (seen.has(view.name)) continue
      seen.add(view.name)
      const risk = view.annotations.readOnlyHint ? 'read' as const : (registry.get(view.name)?.risk ?? 'read' as const)
      summaries.push({ name: view.name, description: view.description, risk, enabled: visible.has(view.name) })
    }
    for (const tool of registry.list()) {
      if (!seen.has(tool.name)) {
        summaries.push({ name: tool.name, description: tool.description, risk: tool.risk, enabled: false })
      }
    }
    return summaries
  }
}

export const promaMcpServerService = new PromaMcpServerService()
