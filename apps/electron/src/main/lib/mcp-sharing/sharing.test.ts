import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import type { McpShareRoot } from '@proma/shared'
import { resolveShareRoot, validateShareFolder } from './roots'
import { migrateSharing, normalizeSharing } from './config'
import { normalizePromaMcpServerConfig } from '../mcp-server/config'
import { createPrimitiveCatalog, toolFingerprint, withDelegation } from './catalog'
import { AnalysisTaskQueue } from './task-queue'
import { selectPiToolCatalog } from '../adapters/pi-tool-catalog'
import { authorizeAnalysisRoot } from './analysis-policy'

describe('V11 Sharing / 低成本脚本回归', () => {
  it('Given 托管、本地项目、额外目录 When 解析与移除 Then 统一健康状态并拒绝广泛授权', async () => {
    const base = mkdtempSync(join(tmpdir(), 'proma-share-test-'))
    const managed = join(base, 'managed'); const local = join(base, 'local'); const extra = join(base, 'extra'); const outside = join(base, 'outside')
    for (const path of [managed, local, extra, outside]) { mkdirSync(path); writeFileSync(join(path, 'README.md'), path === outside ? 'NOT AUTHORIZED' : 'fixture') }
    const roots: McpShareRoot[] = [
      { id: 'ws_m', name: 'managed', source: { type: 'agent-workspace', agentWorkspaceId: 'm' }, enabled: true, permissions: { read: true, write: false, shell: false }, createdAt: 1 },
      { id: 'ws_l', name: 'local', source: { type: 'agent-workspace', agentWorkspaceId: 'l' }, enabled: true, permissions: { read: true, write: false, shell: false }, createdAt: 1 },
      { id: 'ws_e', name: 'extra', source: { type: 'local-folder', path: extra }, enabled: true, permissions: { read: true, write: false, shell: false }, createdAt: 1 },
    ]
    const resolver = { workspace: (id: string) => ({ id, name: id, slug: id, projectRootPath: id === 'l' ? local : undefined }), managedPath: () => managed }
    let config = normalizeSharing({ ...migrateSharing(normalizePromaMcpServerConfig(undefined)), enabled: true, roots })
    const entries = () => config.roots.flatMap((r) => { const { entry } = resolveShareRoot(r, resolver); return entry ? [entry] : [] })
    const tools = createPrimitiveCatalog(() => config, entries, (id) => { const entry = entries().find((e) => e.id === id)!; return { entry, context: { rootPath: entry.rootPath, workspaceId: id } } })
    try {
      expect(roots.map((r) => resolveShareRoot(r, resolver).health.kind)).toEqual(['managed-project','local-project','extra-folder'])
      for (const root of roots) expect((await tools.call('read_file', { workspace_id: root.id, path: 'README.md' })).isError).toBe(false)
      const fingerprint = toolFingerprint(tools)
      config = { ...config, roots: config.roots.filter((r) => r.id !== 'ws_l') }
      expect(toolFingerprint(tools)).toBe(fingerprint)
      expect((await tools.call('read_file', { workspace_id: 'ws_l', path: 'README.md' })).isError).toBe(true)
      symlinkSync(outside, join(extra, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
      expect((await tools.call('read_file', { workspace_id: 'ws_e', path: 'escape/README.md' })).isError).toBe(true)
      config = { ...config, tools: { ...config.tools, git: false } }
      expect(tools.list().some((t) => t.name === 'git_status')).toBe(false)
      expect(toolFingerprint(tools)).not.toBe(fingerprint)
      rmSync(extra, { recursive: true, force: true })
      expect(resolveShareRoot(roots[2]!, resolver).health.state).toBe('missing')
      expect(() => validateShareFolder(homedir())).toThrow('SHARE_FOLDER_TOO_BROAD')
    } finally { rmSync(base, { recursive: true, force: true }) }
  })
  it('Given Agent 独占目录 When 选择运行时工具 Then 原生/写入/递归工具工厂不执行', () => {
    let called = false
    const tools = selectPiToolCatalog(true, () => ['mcp_analysis_read_file'], () => { called = true; return ['Bash','Write','proma_task_start'] })
    expect(called).toBe(false)
    expect(tools).toEqual(['mcp_analysis_read_file'])
    expect(selectPiToolCatalog(false, () => [], () => ['Read','Write'])).toEqual(['Read','Write'])
  })
  it('Given opt-in false/true When MCP Catalog 变化 Then 服务工具独立且 fingerprint 变化', () => {
    let enabled = false
    const primitive = { list: () => [], call: async () => ({ content: [] }) }
    const queue = new AnalysisTaskQueue({ run: async () => 'unused' }, () => undefined)
    const catalog = withDelegation(primitive, () => enabled, queue)
    const first = toolFingerprint(catalog)
    expect(catalog.list()).toHaveLength(0)
    enabled = true
    expect(catalog.list().map((t) => t.name)).toContain('proma_task_start')
    expect(toolFingerprint(catalog)).not.toBe(first)
    expect(primitive.list()).toHaveLength(0)
  })
  it('Given 额外目录或未授权项目 When 委派 Then 拒绝；只有明确Agent项目可绑定任务', () => {
    const config = normalizeSharing({ enabled: true, roots: [
      { id: 'extra', name: 'extra', source: { type: 'local-folder', path: '/fixture' }, enabled: true, permissions: { read: true }, createdAt: 1 },
      { id: 'agent', name: 'agent', source: { type: 'agent-workspace', agentWorkspaceId: 'bound-agent-id' }, enabled: true, permissions: { read: true }, createdAt: 1 },
    ], delegation: { enabled: true } })
    expect(() => authorizeAnalysisRoot(config, ['extra'], 'extra')).toThrow('PROMA 项目')
    expect(() => authorizeAnalysisRoot(config, [], 'agent')).toThrow('TASK_SCOPE_DENIED')
    expect(authorizeAnalysisRoot(config, ['agent'], 'agent').source.agentWorkspaceId).toBe('bound-agent-id')
    expect(() => authorizeAnalysisRoot({ ...config, delegation: { ...config.delegation, enabled: false } }, ['agent'], 'agent')).toThrow()
  })
})
