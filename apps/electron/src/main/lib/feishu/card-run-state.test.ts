import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload, RunModelSnapshot } from '@proma/shared'
import { formatExecutedModelDisplay } from '@proma/shared'
import { createInitialState, reduce } from './card-run-state'

const runModel: RunModelSnapshot = {
  requested: { channelId: 'channel-a', modelId: 'model-a' },
  executed: {
    channelId: 'channel-a',
    channelName: '渠道 A',
    modelId: 'model-b',
    modelName: '模型 B',
  },
  fallback: { used: true, fromModelId: 'model-a' },
  capturedAt: '2026-09-21T00:00:00.000Z',
}

describe('飞书运行卡片模型归因', () => {
  test('Given 当前绑定请求 A When SDK 确认执行 B Then 终态始终展示快照中的 B', () => {
    const resolved = reduce(createInitialState(), {
      kind: 'proma_event',
      event: { type: 'model_resolved', model: 'model-b', runModel },
    } satisfies AgentStreamPayload)
    const completed = reduce(resolved, {
      kind: 'sdk_message',
      message: {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
        runModel,
      },
    } satisfies AgentStreamPayload)

    expect(completed.meta.runModel).toEqual(runModel)
    expect(formatExecutedModelDisplay(completed.meta.runModel)).toBe('渠道 A / 模型 B')
  })
})
