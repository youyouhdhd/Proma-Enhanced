import { describe, expect, test } from 'bun:test'
import {
  MAX_CUSTOM_CONTEXT_WINDOW,
  MIN_CUSTOM_CONTEXT_WINDOW,
  parseCustomContextWindow,
} from './context-window'

describe('渠道模型自定义上下文窗口', () => {
  test('合法整数在边界内被接受', () => {
    expect(parseCustomContextWindow('200000')).toBe(200_000)
    expect(parseCustomContextWindow(1_000_000)).toBe(1_000_000)
    expect(parseCustomContextWindow(String(MIN_CUSTOM_CONTEXT_WINDOW))).toBe(MIN_CUSTOM_CONTEXT_WINDOW)
    expect(parseCustomContextWindow(String(MAX_CUSTOM_CONTEXT_WINDOW))).toBe(MAX_CUSTOM_CONTEXT_WINDOW)
  })

  test('空白、非整数与越界值按未配置处理', () => {
    expect(parseCustomContextWindow('')).toBeUndefined()
    expect(parseCustomContextWindow('   ')).toBeUndefined()
    expect(parseCustomContextWindow(undefined)).toBeUndefined()
    expect(parseCustomContextWindow(null)).toBeUndefined()
    expect(parseCustomContextWindow('12.5')).toBeUndefined()
    expect(parseCustomContextWindow('abc')).toBeUndefined()
    expect(parseCustomContextWindow('7999')).toBeUndefined()
    expect(parseCustomContextWindow(String(MAX_CUSTOM_CONTEXT_WINDOW + 1))).toBeUndefined()
  })
})
