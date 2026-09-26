import { describe, expect, test } from 'bun:test'
import { buildCodexCatalogModel, compilePiChannelReasoningCapabilities, resolvePiReasoningCapability } from './pi-model-registry'
import { codexCatalogReasoning, parseCodexModelCatalog } from '../codex-model-catalog'

describe('Codex 远端目录', () => {
  const entry = parseCodexModelCatalog({ models: [{
    slug: 'future-model', display_name: '未来模型', visibility: 'list', context_window: 777_777,
    supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'max' }], default_reasoning_level: 'medium',
  }] })[0]!
  test('Given 旧 Pi 不认识的模型 When 注册 Then 采用提供者 ID、窗口和档位', () => {
    const model = buildCodexCatalogModel(entry)
    expect(model.id).toBe('future-model')
    expect(model.api).toBe('openai-codex-responses')
    expect(model.contextWindow).toBe(777_777)
    expect(model.thinkingLevelMap?.max).toBe('max')
    expect(model.thinkingLevelMap?.high).toBeNull()
    const known = { ...model, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 }, compat: { supportsToolSearch: true } }
    const refreshed = buildCodexCatalogModel({ ...entry, context_window: 900_000 }, known)
    expect(refreshed.cost).toEqual(known.cost)
    expect(refreshed.compat).toEqual(known.compat)
    expect(refreshed.contextWindow).toBe(900_000)
  })

  test('Given 账号能力与静态 profile 不同 When 解析 Codex 档位 Then 提供者能力优先', async () => {
    expect(await resolvePiReasoningCapability('openai-codex', 'gpt-6-astra', codexCatalogReasoning(entry)))
      .toEqual({ source: 'channel', levels: ['medium', 'max'], defaultLevel: 'medium' })
  })
})

describe('自建模型推理能力', () => {
  const reasoning = {
    levels: ['off', 'low', 'medium', 'high'] as const,
    defaultLevel: 'high' as const,
    thinkingLevelMap: { off: 'none' },
  }

  test('OpenAI 兼容模型注册 reasoning_effort 与档位映射', () => {
    expect(compilePiChannelReasoningCapabilities('openai-completions', {
      ...reasoning,
      levels: [...reasoning.levels],
    })).toEqual({
      compat: { supportsReasoningEffort: true, supportsStrictMode: false },
      thinkingLevelMap: { off: 'none' },
    })
  })

  test('频道声明为目录外模型提供会话级滑杆能力', async () => {
    await expect(resolvePiReasoningCapability('openai', 'qwen3.8-27b-q8', {
      ...reasoning,
      levels: [...reasoning.levels],
    })).resolves.toEqual({
      source: 'channel',
      levels: ['off', 'low', 'medium', 'high'],
      defaultLevel: 'high',
    })
  })

  test('Anthropic transport 不应用 OpenAI 推理声明', () => {
    expect(compilePiChannelReasoningCapabilities('anthropic-messages', {
      ...reasoning,
      levels: [...reasoning.levels],
    })).toBeUndefined()
  })

  test('内置模型的已验证 profile 优先于频道声明', async () => {
    await expect(resolvePiReasoningCapability('openai', 'gpt-5.5', {
      levels: ['off', 'high'],
      defaultLevel: 'high',
    })).resolves.toEqual({
      source: 'profile',
      levels: ['off', 'low', 'medium', 'high', 'xhigh'],
      defaultLevel: 'high',
    })
  })
})
