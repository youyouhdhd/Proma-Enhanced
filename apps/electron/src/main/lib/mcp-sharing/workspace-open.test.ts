import { it, expect } from 'bun:test'
import { handleWorkspaceOpen, resolveTargetWorkspace } from '../mcp-server/multi-workspace'

it('Given 多项目 When 按名称打开和省略ID Then 返回稳定ID且不修改隐式当前项目', () => {
  const entries = ['one', 'two'].map((id) => ({ id, name: id, rootPath: id, enabled: true, permissions: { read: true, write: false, shell: false } }))
  expect(handleWorkspaceOpen({ name: 'two' }, entries).data?.workspace_id).toBe('two')
  const unresolved = resolveTargetWorkspace(undefined, entries)
  expect('error' in unresolved && unresolved.error.code).toBe('WORKSPACE_REQUIRED')
  expect('error' in unresolved && unresolved.error.choices).toHaveLength(2)
  entries.pop()
  expect(handleWorkspaceOpen({ workspace_id: 'two' }, entries).ok).toBe(false)
  expect(handleWorkspaceOpen({}, entries).data?.workspace_id).toBe('one')
})
