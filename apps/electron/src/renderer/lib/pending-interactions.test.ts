import { describe, expect, test } from 'bun:test'
import { queuePendingInteraction, resolvePendingInteraction } from './pending-interactions'

interface Request { sessionId: string; requestId: string }
const request: Request = { sessionId: 's', requestId: 'r' }

describe('交互快照与实时事件恢复', () => {
  test('Given 实时请求已到 When 同一快照抵达 Then 只保留一条', () => {
    const resolved = new Set<string>()
    const current = queuePendingInteraction(new Map<string, readonly Request[]>(), request, resolved)
    expect(queuePendingInteraction(current, request, resolved)).toBe(current)
    expect(current.get('s')).toHaveLength(1)
  })

  test('Given resolved 先抵达 When 迟到快照恢复 Then 不复活卡片', () => {
    const resolved = new Set<string>()
    const current = resolvePendingInteraction(new Map<string, readonly Request[]>(), 'r', resolved)
    expect(queuePendingInteraction(current, request, resolved)).toBe(current)
  })

  test('Given 多会话请求 When 解决一个 Then 其他会话与未决请求保留', () => {
    const resolved = new Set<string>()
    let current = queuePendingInteraction(new Map<string, readonly Request[]>(), request, resolved)
    current = queuePendingInteraction(current, { sessionId: 'other', requestId: 'other' }, resolved)
    current = resolvePendingInteraction(current, 'r', resolved)
    expect(current.has('s')).toBe(false)
    expect(current.get('other')).toHaveLength(1)
    expect(resolvePendingInteraction(current, 'r', resolved)).toBe(current)
  })
})
