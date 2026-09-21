import { describe, expect, test } from 'bun:test'
import {
  getRuntimeNavigationScrollTarget,
  motionSafeScrollBehavior,
  motionSafeStickBehavior,
  nextPendingEventCount,
} from './runtime-navigation'

describe('长运行导航状态', () => {
  test('Given 用户暂停阅读 When 稳定消息组增加 Then 只累计新增组并在回到底部后清零', () => {
    expect(nextPendingEventCount({ previousEventCount: 10, eventCount: 13, pendingEventCount: 2, isAtBottom: false })).toBe(5)
    expect(nextPendingEventCount({ previousEventCount: 13, eventCount: 13, pendingEventCount: 5, isAtBottom: false })).toBe(5)
    expect(nextPendingEventCount({ previousEventCount: 13, eventCount: 0, pendingEventCount: 5, isAtBottom: false })).toBe(5)
    expect(nextPendingEventCount({ previousEventCount: 13, eventCount: 14, pendingEventCount: 5, isAtBottom: true })).toBe(0)
  })

  test('Given 自定义滚动滑块 When 键盘导航 Then 目标始终限制在可滚动范围内', () => {
    const metrics = { scrollTop: 500, clientHeight: 400, scrollHeight: 2_000 }
    expect(getRuntimeNavigationScrollTarget('Home', metrics)).toBe(0)
    expect(getRuntimeNavigationScrollTarget('End', metrics)).toBe(1_600)
    expect(getRuntimeNavigationScrollTarget('PageDown', metrics)).toBe(860)
    expect(getRuntimeNavigationScrollTarget('ArrowUp', { ...metrics, scrollTop: 10 })).toBe(0)
    expect(getRuntimeNavigationScrollTarget('Escape', metrics)).toBeUndefined()
  })

  test('Given Reduced Motion When 解析滚动行为 Then 不使用平滑动画', () => {
    expect(motionSafeScrollBehavior(true)).toBe('auto')
    expect(motionSafeStickBehavior(true)).toBe('instant')
    expect(motionSafeScrollBehavior(false)).toBe('smooth')
  })

  test('Given 2,000 次 paused 增量 When 计数 Then 结果稳定且不需要列表虚拟化状态', () => {
    let pending = 0
    for (let count = 1; count <= 2_000; count++) {
      pending = nextPendingEventCount({
        previousEventCount: count - 1,
        eventCount: count,
        pendingEventCount: pending,
        isAtBottom: false,
      })
    }
    expect(pending).toBe(2_000)
  })
})
