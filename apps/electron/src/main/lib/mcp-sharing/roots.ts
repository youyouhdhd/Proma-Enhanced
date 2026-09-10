import { existsSync, realpathSync, statSync, accessSync, constants } from 'node:fs'
import { resolve, parse, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import type { McpShareRoot, McpShareRootHealth } from '@proma/shared'
import type { WorkspaceDirectoryEntry } from '../mcp-server/multi-workspace'

export interface ShareWorkspace { id: string; name: string; projectRootPath?: string; slug: string }
export interface RootResolver { workspace(id: string): ShareWorkspace | null | undefined; managedPath(slug: string): string }
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
export function shareFolderIdentity(path: string): string {
  const real = realpathSync.native(path)
  if (process.platform === 'win32') {
    const stat = statSync(real, { bigint: true })
    if (stat.ino !== 0n) return `win32:${stat.dev}:${stat.ino}`
  }
  return key(real)
}
export function validateShareFolder(path: string): string {
  if (!isAbsolute(path)) throw new Error('SHARE_FOLDER_MISSING')
  const absolute = resolve(path)
  if (key(absolute) === key(parse(absolute).root) || key(absolute) === key(resolve(homedir()))) throw new Error('SHARE_FOLDER_TOO_BROAD')
  if (!existsSync(path)) throw new Error('SHARE_FOLDER_MISSING')
  const real = realpathSync.native(path)
  if (!statSync(real).isDirectory()) throw new Error('SHARE_FOLDER_NOT_DIRECTORY')
  const forbidden = process.platform === 'win32'
    ? [process.env.SystemRoot ?? 'C:\\Windows', process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)']
    : ['/etc', '/usr', '/bin', '/sbin', '/System', '/Library', '/Applications']
  if (key(real) === key(parse(real).root) || key(real) === key(resolve(homedir())) || forbidden.some((base) => {
    const rel = relative(key(resolve(base)), key(real)); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel)
  })) throw new Error('SHARE_FOLDER_TOO_BROAD')
  accessSync(real, constants.R_OK)
  return real
}
export function resolveShareRoot(root: McpShareRoot, resolver: RootResolver): { health: McpShareRootHealth; entry?: WorkspaceDirectoryEntry } {
  let kind: McpShareRootHealth['kind'] = 'extra-folder'
  try {
    let path: string
    if (root.source.type === 'agent-workspace') {
      const workspace = resolver.workspace(root.source.agentWorkspaceId)
      if (!workspace) throw new Error('SHARE_FOLDER_MISSING')
      kind = workspace.projectRootPath ? 'local-project' : 'managed-project'
      path = workspace.projectRootPath ?? resolver.managedPath(workspace.slug)
    } else path = root.source.path
    const real = validateShareFolder(path)
    // 固定路径校验沿用保存时的 realpath 表示；native 可将 Windows 8.3 名称展开。
    // 不能拿 native 长路径直接与保存的短路径比较，否则会误拒绝合法目录。
    if (root.source.type === 'local-folder' && key(realpathSync(root.source.path)) !== key(resolve(root.source.path))) throw new Error('SHARE_ROOT_CHANGED')
    return { health: { id: root.id, kind, state: 'available', path: real }, entry: { id: root.id, name: root.name, rootPath: real, enabled: root.enabled, permissions: root.permissions } }
  } catch (error) {
    const missing = error instanceof Error && (error.message === 'SHARE_FOLDER_MISSING' || 'code' in error && error.code === 'ENOENT')
    return { health: { id: root.id, kind, state: missing ? 'missing' : 'denied', message: missing ? '目录不存在或已移动' : '目录不可访问、范围过宽或链接目标已变化' } }
  }
}
