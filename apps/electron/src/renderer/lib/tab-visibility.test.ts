import { expect, test } from 'bun:test'
import { getScrollLeftToRevealTab } from './tab-visibility'

test('Given 右侧标签条改变宽度 When 重新计算 Then 活动标签仍完整可见', () => {
  const tab = { offsetLeft: 520, offsetWidth: 100 }
  expect(getScrollLeftToRevealTab({ scrollLeft: 0, clientWidth: 300, scrollWidth: 900 }, tab)).toBe(320)
  expect(getScrollLeftToRevealTab({ scrollLeft: 300, clientWidth: 600, scrollWidth: 900 }, tab)).toBe(300)
  expect(getScrollLeftToRevealTab({ scrollLeft: 320, clientWidth: 150, scrollWidth: 900 }, tab)).toBe(470)
})

test('Given 标签宽于视口或位于左侧 When 定位 Then 展示起点且不越过滚动范围', () => {
  expect(getScrollLeftToRevealTab({ scrollLeft: 300, clientWidth: 100, scrollWidth: 900 }, { offsetLeft: 50, offsetWidth: 150 })).toBe(50)
  expect(getScrollLeftToRevealTab({ scrollLeft: 0, clientWidth: 100, scrollWidth: 900 }, { offsetLeft: 850, offsetWidth: 150 })).toBe(800)
})
