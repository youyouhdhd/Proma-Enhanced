/**
 * MCP Server 服务单例（第二轮：Workspace Registry 架构）
 * - 从应用设置读取配置（含多 Workspace 注册表）并启动/停止；
 * - 每次工具调用时按 workspace 条目解析 Agent 工作区 rootPath（不缓存过期路径）；
 * - 对 IPC 暴露状态/启动/停止/更新配置/工具列表。
 */

import { existsSync } from 'node:fs'
import type { PromaMcpServerConfig, PromaMcpServerStatus, PromaMcpToolSummary } from '@proma/shared'
import { getSettings } from '../settings-service'
import { getAgentWorkspace, getProjectFilesPath } from '../agent-workspace-manager'
import { normalizePromaMcpServerConfig } from './config'
import { createDefaultLocalToolRegistry, LocalToolRegistry } from '../local-tools/registry'
import type { LocalToolContext } from '../local-tools'
import { buildMcpToolViews } from './tool-adapter'
import { PromaMcpServer } from './server'
import type { WorkspaceDirectoryEntry } from './multi-workspace'

const registry: LocalToolRegistry = createDefaultLocalToolRegistry()

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

  /** 按当前设置启动（设置未启用或未授权任何项目时抛错） */
  async startFromSettings(): Promise<PromaMcpServerStatus> {
    const settings = getSettings()
    const config = normalizePromaMcpServerConfig(settings.mcpServer)
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
    })
  }

  async stop(): Promise<void> {
    await this.server.stop()
  }

  getStatus(): PromaMcpServerStatus {
    return this.server.getStatus()
  }

  /** 更新配置并按需启动/停止/重启 */
  async applyConfig(config: PromaMcpServerConfig): Promise<PromaMcpServerStatus> {
    const normalized = normalizePromaMcpServerConfig(config)
    const wasRunning = this.server.running
    if (wasRunning) await this.server.stop()
    if (normalized.enabled) {
      if (normalized.workspaces.filter((w) => w.enabled).length === 0) {
        throw new Error('MCP Server 尚未授权任何项目，请先在设置中选择要共享的 Workspace。')
      }
      return this.server.start({
        config: normalized,
        listWorkspaces: () => listWorkspaceEntries(normalized),
        resolveWorkspaceContext: (entryId) => {
          try {
            const entry = resolveWorkspaceEntry(normalized, entryId)
            return workspaceContext(entry)
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
          }
        },
        registry,
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
