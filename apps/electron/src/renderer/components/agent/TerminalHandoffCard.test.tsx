import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AskUserRequest } from '@proma/shared'
import { AskUserBanner } from './AskUserBanner'
import {
  allPendingAskUserRequestsAtom,
  allPendingPermissionRequestsAtom,
  allPendingExitPlanRequestsAtom,
  agentSessionInteractionLabelAtomFamily,
  agentSessionIndicatorMapAtom,
  agentStreamingStatesAtom,
  askUserDraftsAtom,
} from '@/atoms/agent-atoms'

const request: AskUserRequest = {
  requestId: 'handoff-1', sessionId: 'session-1', toolInput: {},
  questions: [{ question: '请在终端确认 <继续>', options: [] }],
  terminal: { terminalId: 'terminal-1', title: '安装终端' },
}

describe('终端接管组件与状态', () => {
  test('Given 接管请求但无运行快照 When 恢复 Then 显示卡片、等待文案与 blocked', () => {
    const store = createStore()
    store.set(allPendingAskUserRequestsAtom, new Map([[request.sessionId, [request]]]))
    const markup = renderToStaticMarkup(<Provider store={store}><AskUserBanner sessionId={request.sessionId} /></Provider>)
    expect(markup).toContain('等待你操作终端')
    expect(markup).toContain('打开终端')
    expect(markup).toContain('已完成，继续')
    expect(markup).toContain('遇到问题')
    expect(markup).toContain('取消任务')
    expect(markup).toContain('&lt;继续&gt;')
    expect(markup).not.toContain('<继续>')
    expect(store.get(agentSessionInteractionLabelAtomFamily(request.sessionId))).toBe('等待你操作终端')
    expect(store.get(agentSessionIndicatorMapAtom).get(request.sessionId)).toBe('blocked')
  })

  test('Given 反馈草稿 When 卡片重新渲染 Then 保留内容并提供可访问标签与输入长度限制', () => {
    const store = createStore()
    store.set(allPendingAskUserRequestsAtom, new Map([[request.sessionId, [request]]]))
    store.set(askUserDraftsAtom, new Map([[request.requestId, {
      activeTab: 0, focusedOptIdx: -1,
      answers: new Map([[0, { selected: [], customText: '安装失败，需要帮助', showCustom: true }]]),
    }]]))
    const markup = renderToStaticMarkup(<Provider store={store}><AskUserBanner sessionId={request.sessionId} /></Provider>)
    expect(markup).toContain('安装失败，需要帮助')
    expect(markup).toContain('for="terminal-feedback-handoff-1"')
    expect(markup).toContain('maxLength="4000"')
    expect(markup).toContain('停止 Agent，终端保留')
  })

  test('Given 普通问答 When 未绑定终端 Then 仍显示普通问答并能清除等待状态', () => {
    const store = createStore()
    store.set(agentStreamingStatesAtom, new Map([[request.sessionId, { running: true }]]))
    store.set(allPendingAskUserRequestsAtom, new Map([[request.sessionId, [{ ...request, terminal: undefined }]]]))
    const markup = renderToStaticMarkup(<Provider store={store}><AskUserBanner sessionId={request.sessionId} /></Provider>)
    expect(markup).toContain('Proma Agent 需要你的输入')
    expect(markup).not.toContain('打开终端')
    expect(store.get(agentSessionInteractionLabelAtomFamily(request.sessionId))).toBe('等待你的回答')
    store.set(allPendingAskUserRequestsAtom, new Map())
    expect(store.get(agentSessionInteractionLabelAtomFamily(request.sessionId))).toBeNull()
    expect(store.get(agentSessionIndicatorMapAtom).get(request.sessionId)).toBe('running')
    store.set(allPendingPermissionRequestsAtom, new Map([[request.sessionId, [{ requestId: 'permission', sessionId: request.sessionId, toolName: 'Bash', toolInput: {}, description: '执行命令', dangerLevel: 'normal' }]]]))
    expect(store.get(agentSessionInteractionLabelAtomFamily(request.sessionId))).toBe('等待权限确认')
    store.set(allPendingPermissionRequestsAtom, new Map())
    store.set(allPendingExitPlanRequestsAtom, new Map([[request.sessionId, [{ requestId: 'plan', sessionId: request.sessionId, toolInput: {}, allowedPrompts: [] }]]]))
    expect(store.get(agentSessionInteractionLabelAtomFamily(request.sessionId))).toBe('等待计划审批')
  })
})
