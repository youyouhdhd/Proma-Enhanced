import { describe, expect, test } from 'bun:test'
import type { AskUserRequest } from '@proma/shared'
import { AgentAskUserService } from './agent-ask-user-service'

const terminal = { terminalId: 'terminal-1', title: '安装终端' }
const input = { terminalId: terminal.terminalId, questions: [{ question: '请在终端完成确认' }] }

describe('终端接管问答生命周期', () => {
  test('Given 终端请求 When 尚未回复 Then 工具挂起且用户完成后返回结构化声明', async () => {
    const service = new AgentAskUserService()
    const controller = new AbortController()
    let request!: AskUserRequest
    let settled = false
    const result = service.handleAskUserQuestion('session-1', input, controller.signal, (value) => { request = value }, terminal)
    void result.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(request.terminal).toEqual(terminal)
    expect(service.getPendingRequests()).toHaveLength(1)
    expect(service.respondToAskUser(request.requestId, {}, { outcome: 'completed' })).toBe('session-1')
    expect(await result).toMatchObject({ behavior: 'allow', updatedInput: {
      answers: {}, terminalInteraction: { terminalId: terminal.terminalId, outcome: 'completed' },
    } })
    expect(service.getPendingRequests()).toHaveLength(0)
    expect(service.respondToAskUser(request.requestId, {})).toBeNull()
  })

  test('Given 问题反馈 When 用户提交 Then 返回说明而不执行终端输入', async () => {
    const service = new AgentAskUserService()
    let request!: AskUserRequest
    const result = service.handleAskUserQuestion('s', input, new AbortController().signal, (value) => { request = value }, terminal)
    service.respondToAskUser(request.requestId, {}, { outcome: 'problem', message: '登录失败' })
    expect(await result).toMatchObject({ updatedInput: { terminalInteraction: { outcome: 'problem', message: '登录失败' } } })
  })

  test('Given 普通问答 When 同步通知中回复 Then 保持原 answers 兼容', async () => {
    const service = new AgentAskUserService()
    const result = await service.handleAskUserQuestion('s', { questions: [{ question: '选择' }] }, new AbortController().signal,
      (request) => { service.respondToAskUser(request.requestId, { 选择: '选项一' }) })
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 选择: '选项一' } } })
    if (result.behavior === 'allow') expect(result.updatedInput.terminalInteraction).toBeUndefined()
  })

  test('Given 旧 bridge When 回复固定完成选项 Then 兼容为完成声明', async () => {
    const service = new AgentAskUserService()
    const result = service.handleAskUserQuestion('s', input, new AbortController().signal,
      (request) => { service.respondToAskUser(request.requestId, { 操作: '已完成，继续' }) }, terminal)
    expect(await result).toMatchObject({ updatedInput: { terminalInteraction: { outcome: 'completed' } } })
  })

  test('Given 已中止 signal When 请求接管 Then 不登记或展示请求', async () => {
    const service = new AgentAskUserService()
    const controller = new AbortController()
    controller.abort()
    let shown = false
    const result = await service.handleAskUserQuestion('s', input, controller.signal, () => { shown = true }, terminal)
    expect(result.behavior).toBe('deny')
    expect(shown).toBe(false)
    expect(service.getPendingRequests()).toHaveLength(0)
  })

  test('Given 待处理接管 When Agent 中止 Then 请求移除并发送 resolved 一次', async () => {
    const service = new AgentAskUserService()
    const controller = new AbortController()
    const resolved: string[] = []
    let request!: AskUserRequest
    const result = service.handleAskUserQuestion('s', input, controller.signal, (value) => { request = value }, terminal, (id) => resolved.push(id))
    controller.abort()
    expect((await result).behavior).toBe('deny')
    expect(resolved).toEqual([request.requestId])
    expect(service.getPendingRequests()).toHaveLength(0)
    expect(service.respondToAskUser(request.requestId, {})).toBeNull()
  })

  test('Given 接管请求 When 对应终端关闭 Then 返回 unavailable 且其他终端请求保留', async () => {
    const service = new AgentAskUserService()
    const resolved: string[] = []
    let other!: AskUserRequest
    const result = service.handleAskUserQuestion('s', input, new AbortController().signal, () => {}, terminal, (id) => resolved.push(id))
    const otherResult = service.handleAskUserQuestion('s2', input, new AbortController().signal, (value) => { other = value }, { ...terminal, terminalId: 'other' })
    service.resolveTerminalUnavailable(terminal.terminalId)
    service.resolveTerminalUnavailable(terminal.terminalId)
    expect(await result).toMatchObject({ updatedInput: { terminalInteraction: { outcome: 'unavailable' } } })
    expect(resolved).toHaveLength(1)
    expect(service.getPendingRequests()).toHaveLength(1)
    service.respondToAskUser(other.requestId, {}, { outcome: 'completed' })
    await otherResult
  })

  test('Given 已回复接管 When signal 随后中止 Then 不再发过期 resolved', async () => {
    const service = new AgentAskUserService()
    const controller = new AbortController()
    let count = 0
    const result = service.handleAskUserQuestion('s', input, controller.signal,
      (request) => { service.respondToAskUser(request.requestId, {}, { outcome: 'completed' }) }, terminal, () => { count++ })
    await result
    controller.abort()
    expect(count).toBe(0)
  })

  test('Given 空说明或多个问题 When 请求终端接管 Then 明确拒绝且无 pending', () => {
    const service = new AgentAskUserService()
    for (const questions of [[], [{ question: ' ' }], [{ question: 'a' }, { question: 'b' }], [{ question: 'a'.repeat(4_001) }], [null]]) {
      expect(() => service.handleAskUserQuestion('s', { questions }, new AbortController().signal, () => {}, terminal)).toThrow()
    }
    expect(service.getPendingRequests()).toHaveLength(0)
  })

  test('Given 非法/过长反馈 When 提交 Then 不结算请求并允许正确重试', async () => {
    const service = new AgentAskUserService()
    let request!: AskUserRequest
    const result = service.handleAskUserQuestion('s', input, new AbortController().signal, (value) => { request = value }, terminal)
    expect(() => service.respondToAskUser(request.requestId, {}, { outcome: 'problem', message: 'a'.repeat(4_001) })).toThrow()
    expect(() => service.respondToAskUser(request.requestId, { bad: 'a'.repeat(10_001) })).toThrow()
    expect(service.getPendingRequests()).toHaveLength(1)
    service.respondToAskUser(request.requestId, {}, { outcome: 'completed' })
    await result
  })
})
