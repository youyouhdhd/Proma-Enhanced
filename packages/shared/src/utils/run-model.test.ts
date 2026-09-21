import { describe, expect, test } from 'bun:test'
import { createRunModelSnapshot, formatExecutedModelDisplay, getExecutedModelId } from './run-model'

const channel = {
  id: 'channel-a',
  name: '渠道 A',
  models: [
    { id: 'model-a', name: '模型 A', enabled: true },
    { id: 'model-b', name: '模型 B', enabled: true },
  ],
}

describe('每轮实际模型快照', () => {
  test('Given 请求模型 A When 实际执行 B Then 记录 fallback 并只展示 B', () => {
    const snapshot = createRunModelSnapshot({
      channel,
      requestedModelId: 'model-a',
      executedModelId: 'model-b[1m]',
      capturedAt: '2026-09-21T00:00:00.000Z',
    })

    expect(snapshot.fallback).toEqual({ used: true, fromModelId: 'model-a' })
    expect(snapshot.executed?.modelId).toBe('model-b')
    expect(getExecutedModelId(snapshot)).toBe('model-b')
    expect(formatExecutedModelDisplay(snapshot)).toBe('渠道 A / 模型 B')
  })

  test('Given 只有 requested When 展示模型 Then 不推测执行事实', () => {
    expect(formatExecutedModelDisplay({
      requested: { channelId: 'channel-a', modelId: 'model-a' },
      capturedAt: '2026-09-21T00:00:00.000Z',
    })).toBeUndefined()
  })
})
