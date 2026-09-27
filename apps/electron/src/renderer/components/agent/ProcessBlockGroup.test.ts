import { describe, expect, test } from 'bun:test'
import {
  buildAssistantTurnRenderItems,
  resolveProgressScrollIntent,
} from './ProcessBlockGroup'

describe('执行过程滚动意图判别', () => {
  test('given scrollTop 与最近程序赋值一致 when 判别 then 视为跟随动画帧并忽略', () => {
    expect(resolveProgressScrollIntent({
      scrollTop: 120,
      lastProgrammaticTop: 120,
      isAtBottom: false,
    })).toBe('programmatic')
  })

  test('given scrollTop 与程序赋值相差 1px 容差内 when 判别 then 仍视为跟随动画帧', () => {
    expect(resolveProgressScrollIntent({
      scrollTop: 121,
      lastProgrammaticTop: 120,
      isAtBottom: false,
    })).toBe('programmatic')
  })

  test('given 用户拖动滑条离开底部 when 判别 then 视为用户滚动并停止跟随', () => {
    expect(resolveProgressScrollIntent({
      scrollTop: 40,
      lastProgrammaticTop: 120,
      isAtBottom: false,
    })).toBe('user-scroll')
  })

  test('given 用户拖回底部附近 when 判别 then 恢复自动跟随', () => {
    expect(resolveProgressScrollIntent({
      scrollTop: 118,
      lastProgrammaticTop: 40,
      isAtBottom: true,
    })).toBe('follow')
  })

  test('given 无程序滚动记录且不在底部 when 判别 then 视为用户滚动', () => {
    expect(resolveProgressScrollIntent({
      scrollTop: 10,
      lastProgrammaticTop: null,
      isAtBottom: false,
    })).toBe('user-scroll')
  })
})

describe('执行过程分组渲染项', () => {
  test('given 纯文本 turn when 构建渲染项 then 不产生过程组', () => {
    const items = buildAssistantTurnRenderItems([
      { type: 'text', text: '答案' },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]!.type).toBe('block')
  })

  test('given 工具与思考块 when 构建渲染项 then 归入过程组', () => {
    const items = buildAssistantTurnRenderItems([
      { type: 'thinking', thinking: '推理' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'text', text: '答案' },
    ])
    expect(items).toHaveLength(2)
    expect(items[0]!.type).toBe('process-group')
    expect(items[1]!.type).toBe('block')
  })
})
