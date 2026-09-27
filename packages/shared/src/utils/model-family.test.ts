import { describe, expect, test } from 'bun:test'
import { isGpt6AstraFamily, isGpt6SolFamily, isGpt6LunaFamily } from './model-family'
import { inferContextWindow, inferCodexAlignedGPT5ContextWindow, isMimoV26Model } from './context-window'
import { isCodexFastModeSupportedModel } from '../types/agent'
import { inferReasoningTransport, resolveReasoningProfile } from '../types/reasoning-profile'

describe('上游模型能力合并边界', () => {
  test('Given GPT-6 标准 ID 和 Astra SKU When 解析 Then 保留精确边界及默认推理档位', () => {
    expect(isGpt6AstraFamily(' GPT-6-ASTRA-PRO[1m] ')).toBe(true)
    expect(isGpt6AstraFamily('gpt-6-astraish')).toBe(false)
    expect(isGpt6SolFamily('gpt-6-sol-preview')).toBe(false)
    expect(isGpt6LunaFamily('vendor-gpt-6-luna')).toBe(false)
    for (const id of ['gpt-6-sol', 'gpt-6-luna']) {
      const profile = resolveReasoningProfile({ modelId: id, transport: 'openai-responses' })
      expect(profile?.defaultLevel).toBe('medium')
      expect(profile?.levels).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
      expect(isCodexFastModeSupportedModel(id)).toBe(true)
      // 新型号窗口由账号/供应商目录决定，不强制覆盖为统一的 372K。
      expect(inferCodexAlignedGPT5ContextWindow(id)).toBeUndefined()
    }
  })

  test('Given MiMo 2.6 与相近非官方 ID When 推断 Then 仅已知型号取得 1M 窗口', () => {
    for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed']) {
      expect(isMimoV26Model(id)).toBe(true)
      expect(inferContextWindow(id)).toBe(1_000_000)
    }
    for (const id of ['mimo-v2.60-pro', 'vendor-mimo-v2.6-pro', 'mimo-v2.6-pro-preview']) {
      expect(isMimoV26Model(id)).toBe(false)
      expect(inferContextWindow(id)).toBe(200_000)
    }
    expect(inferContextWindow('mimo-v2.5-pro')).toBe(1_000_000)
  })

  test('Given Fork 兼容渠道 When 解析协议 Then 保留 OpenCode 与火山套餐原协议', () => {
    expect(inferReasoningTransport('opencode-go-openai')).toBe('openai-completions')
    expect(inferReasoningTransport('doubao')).toBe('openai-completions')
    expect(inferReasoningTransport('ark-coding-plan')).toBe('anthropic-messages')
  })
})
