import { expect, test } from 'bun:test'
import { AgentPermissionService, type CanUseToolOptions } from './agent-permission-service'

function permissionOptions(signal: AbortSignal, toolUseID: string): CanUseToolOptions {
  return { signal, toolUseID, displayName: '删除分组', description: '删除 Todo 分组' }
}

test('Given 已中止的运行 When 请求权限 Then 不留下永久等待或默认批准', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  controller.abort()
  let shown = false
  const notify = (): void => { shown = true }
  const options = permissionOptions(controller.signal, 'aborted-tool')
  expect((await service.createCanUseTool('s', notify)('Bash', { command: 'rm file' }, options)).behavior).toBe('deny')
  expect((await service.requestSingleApproval('s', 'Bash', {}, options, notify)).behavior).toBe('deny')
  expect(shown).toBe(false)
  expect(service.getPendingRequests()).toHaveLength(0)
})

test('Given 权限请求 When UI通知同步回复 Then 已先登记请求且正常解除等待', async () => {
  const service = new AgentPermissionService()
  const options = permissionOptions(new AbortController().signal, 'tool')
  const notify = (request: { requestId: string }): void => {
    expect(service.respondToPermission(request.requestId, 'allow', false)).toBe('s')
  }
  expect((await service.requestSingleApproval('s', 'Bash', {}, options, notify)).behavior).toBe('allow')
  expect((await service.createCanUseTool('s', notify)('Bash', { command: 'rm file' }, options)).behavior).toBe('allow')
  expect(service.getPendingRequests()).toHaveLength(0)
})

test('Given 权限请求挂起 When 用户停止 Then 立即拒绝并清理请求', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  const result = service.requestSingleApproval('s', 'Bash', {}, permissionOptions(controller.signal, 'tool'), () => {})
  expect(service.getPendingRequests()).toHaveLength(1)
  controller.abort()
  expect((await result).behavior).toBe('deny')
  expect(service.getPendingRequests()).toHaveLength(0)
})


test('Given a destructive planning request When it is approved Then approval is single-use and cannot create a session whitelist', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  let firstRequest: { requestId: string; allowAlways?: boolean } | undefined

  const firstResult = service.requestSingleApproval(
    'session-1',
    'mcp__planning__delete_group',
    { id: 'group-1', scope: 'todo' },
    permissionOptions(controller.signal, 'tool-1'),
    (request) => { firstRequest = request },
  )

  expect(firstRequest?.allowAlways).toBe(false)
  expect(service.respondToPermission(firstRequest!.requestId, 'allow', true)).toBe('session-1')
  expect((await firstResult).behavior).toBe('allow')

  let secondRequest: { requestId: string } | undefined
  const secondResult = service.createCanUseTool('session-1', (request) => { secondRequest = request })(
    'mcp__planning__delete_group',
    { id: 'group-2', scope: 'todo' },
    permissionOptions(controller.signal, 'tool-2'),
  )

  expect(secondRequest).toBeDefined()
  expect(service.respondToPermission(secondRequest!.requestId, 'deny', false)).toBe('session-1')
  expect((await secondResult).behavior).toBe('deny')
})
