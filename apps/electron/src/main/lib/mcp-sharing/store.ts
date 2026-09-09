import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import type { McpShareRoot, McpSharingConfig } from '@proma/shared'
import { getConfigDir } from '../config-paths'
import { getSettings } from '../settings-service'
import { getAgentWorkspace, getProjectFilesPath } from '../agent-workspace-manager'
import { normalizePromaMcpServerConfig } from '../mcp-server/config'
import { writeJsonFileAtomic } from '../safe-file'
import { normalizeSharing, migrateSharing } from './config'
import { validateShareFolder, resolveShareRoot } from './roots'

class McpSharingStore {
  private readonly approvedFolders = new Set<string>()
  private readonly listeners = new Set<() => void>()
  onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get(): McpSharingConfig {
    const file = join(getConfigDir(), 'mcp-sharing.json')
    if (existsSync(file)) {
      try { return normalizeSharing(JSON.parse(readFileSync(file, 'utf8'))) } catch { return normalizeSharing(undefined) }
    }
    const config = migrateSharing(normalizePromaMcpServerConfig(getSettings().mcpServer))
    config.roots = config.roots.map((root) => root.source.type === 'agent-workspace' && root.name === root.source.agentWorkspaceId
      ? { ...root, name: getAgentWorkspace(root.source.agentWorkspaceId)?.name ?? root.name } : root)
    mkdirSync(getConfigDir(), { recursive: true }); writeJsonFileAtomic(file, config)
    return config
  }
  prepareFolder(path: string): McpShareRoot {
    const real = validateShareFolder(path)
    this.approvedFolders.add(real)
    return { id: 'ws_folder_' + createHash('sha256').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex').slice(0, 16),
      name: basename(real), source: { type: 'local-folder', path: real }, enabled: true, permissions: { read: true, write: false, shell: false }, createdAt: Date.now() }
  }
  save(value: unknown): McpSharingConfig {
    const next = normalizeSharing(value)
    const previous = this.get()
    for (const root of next.roots) {
      if (root.source.type !== 'local-folder') continue
      const path = root.source.path
      const old = previous.roots.find((r) => r.id === root.id && r.source.type === 'local-folder' && r.source.path === path)
      if (!old && !this.approvedFolders.has(path)) throw new Error('请使用目录选择器明确授权额外文件夹')
      if (!old) validateShareFolder(path)
    }
    writeJsonFileAtomic(join(getConfigDir(), 'mcp-sharing.json'), next)
    for (const listener of this.listeners) listener()
    return next
  }
  resolve(root: McpShareRoot) { return resolveShareRoot(root, { workspace: getAgentWorkspace, managedPath: getProjectFilesPath }) }
  health() { return this.get().roots.map((r) => this.resolve(r).health) }
  entries(ids?: string[]) {
    const config = this.get()
    return config.enabled ? config.roots.filter((r) => !ids || ids.includes(r.id)).flatMap((r) => { const { entry } = this.resolve(r); return entry ? [entry] : [] }) : []
  }
}
export const mcpSharingStore = new McpSharingStore()
