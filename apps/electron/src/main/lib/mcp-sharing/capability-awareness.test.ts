import { expect, it } from 'bun:test'
import { createPrimitiveCatalog } from './catalog'
import { withDelegation } from './catalog'
import { normalizeSharing } from './config'
import { AnalysisTaskQueue } from './task-queue'

it('Given 可见工具和 Agent 配置 When 调用 workspace_list Then 返回直接能力、Agent 状态和项目有效权限', async () => {
  const config = normalizeSharing({ version: 3, enabled: true, roots: [], tools: { fileRead: true, fileWrite: true, search: true, git: true, shell: false }, policy: { read: 'direct', write: 'direct', execute: 'disabled' }, delegation: { enabled: true, action: { mode: 'analysis', write: false, execute: false } } })
  const entry = { id: 'ws_agent', name: 'Agent 项目', rootPath: process.cwd(), enabled: true, agentWorkspaceId: 'agent-workspace', permissions: { read: true, write: true, shell: false } }
  const tools = createPrimitiveCatalog(() => config, () => [entry], () => ({ entry, context: { workspaceId: entry.id, rootPath: entry.rootPath } }))
  const result = await tools.call('workspace_list', {})
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toMatchObject({
    capabilities: { direct: { read: true, write: true, execute: false }, agent: { enabled: true, mode: 'analysis', targetReadiness: 'unknown' } },
    workspaces: [{ effective: { read: true, write: true, execute: false, agentAnalysis: 'unknown', agentAction: 'disabled' } }],
  })
})

it('Given Agent 动作处于本地审批模式 When tools/list 和 workspace_list Then 显式发布动作入口但保留动态项目权限', async () => {
  const config = normalizeSharing({ version: 3, enabled: true, roots: [], tools: { fileRead: true, fileWrite: true, search: true, git: true, shell: false }, policy: { read: 'direct', write: 'direct', execute: 'disabled' }, delegation: { enabled: true, action: { mode: 'approval', write: true, execute: false } } })
  const entry = { id: 'ws_action', name: '动作项目', rootPath: process.cwd(), enabled: true, agentWorkspaceId: 'agent-action', permissions: { read: true, write: true, shell: false } }
  const primitive = createPrimitiveCatalog(() => config, () => [entry], () => ({ entry, context: { workspaceId: entry.id, rootPath: entry.rootPath } }))
  const queue = new AnalysisTaskQueue({ run: async () => 'unused' }, () => undefined)
  const catalog = withDelegation(primitive, () => true, queue, { config: () => config, entries: () => [entry], actionMode: () => 'approval', actionToolsEnabled: () => true })
  expect(catalog.list().map((tool) => tool.name)).toContain('proma_action_start')
  const result = await catalog.call('workspace_list', {})
  expect(result.structuredContent).toMatchObject({ capabilities: { agent: { mode: 'approval', tools: expect.arrayContaining(['proma_action_start']) } } })
})
