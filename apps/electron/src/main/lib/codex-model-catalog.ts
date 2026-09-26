/** Codex 账号模型目录：只接收模型元数据，不导入服务端指令、工具或任意请求地址。 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AgentThinkingLevel, ChannelModel, ChannelModelReasoningConfig, CodexOAuthCredentials } from '@proma/shared'
import { getPromaUserAgent } from '@proma/core'
import { getConfigDir } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import pkg from '../../../package.json' with { type: 'json' }

export interface CodexCatalogModel {
  slug: string
  display_name: string
  visibility: 'list'
  priority: number
  context_window: number
  input_modalities: Array<'text' | 'image'>
  supported_reasoning_levels: Array<{ effort: string }>
  default_reasoning_level?: string
}

const EFFORT_LEVELS: Readonly<Record<string, AgentThinkingLevel | undefined>> = {
  none: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 与 Codex picker 一致只显示 visibility=list；不按旧模型 ID 白名单过滤新模型。 */
export function parseCodexModelCatalog(value: unknown): CodexCatalogModel[] {
  const rows = record(value)?.models
  if (!Array.isArray(rows)) throw new Error('Codex 模型目录格式错误')
  const models = new Map<string, CodexCatalogModel>()
  for (const row of rows) {
    const item = record(row)
    if (!item || item.visibility !== 'list' || typeof item.slug !== 'string' || !item.slug.trim()) continue
    const slug = item.slug.trim()
    const efforts = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels.flatMap((level: unknown) => {
          const effort = record(level)?.effort
          return typeof effort === 'string' && Object.hasOwn(EFFORT_LEVELS, effort) ? [{ effort }] : []
        }) : []
    // 当前 Pi 只支持既有 thinking level；不把无法编码的新档位误报成可用。
    if (Array.isArray(item.supported_reasoning_levels) && item.supported_reasoning_levels.length > 0 && efforts.length === 0) continue
    const modalities = item.input_modalities === undefined ? ['text', 'image'] : item.input_modalities
    const input = Array.isArray(modalities)
      ? modalities.filter((mode): mode is 'text' | 'image' => mode === 'text' || mode === 'image') : []
    if (!input.includes('text')) continue
    const defaultEffort = typeof item.default_reasoning_level === 'string'
      && efforts.some(({ effort }) => effort === item.default_reasoning_level)
      ? item.default_reasoning_level : efforts[0]?.effort
    models.set(slug, {
      slug,
      display_name: typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name.trim() : slug,
      visibility: 'list',
      priority: typeof item.priority === 'number' && Number.isFinite(item.priority) ? item.priority : 0,
      // API 上限与 Codex 默认窗口不同；优先服务端实际窗口，缺失时保守回退。
      context_window: positiveInteger(item.context_window) ?? positiveInteger(item.max_context_window) ?? 200_000,
      input_modalities: input,
      supported_reasoning_levels: efforts,
      ...(defaultEffort && { default_reasoning_level: defaultEffort }),
    })
  }
  const result = [...models.values()].sort((a, b) => a.priority - b.priority)
  if (result.length === 0) throw new Error('Codex 未返回可用模型，已保留原有模型列表')
  return result
}

export function codexCatalogReasoning(model: CodexCatalogModel): ChannelModelReasoningConfig {
  const levels = [...new Set(model.supported_reasoning_levels.map(({ effort }) => EFFORT_LEVELS[effort]!))]
  if (levels.length === 0) return { levels: ['off'], defaultLevel: 'off', thinkingLevelMap: { off: null } }
  return {
    levels,
    defaultLevel: EFFORT_LEVELS[model.default_reasoning_level ?? ''] ?? levels[0]!,
    thinkingLevelMap: Object.fromEntries(model.supported_reasoning_levels.map(({ effort }) => [EFFORT_LEVELS[effort], effort])),
  }
}

export function codexCatalogChannelModels(models: CodexCatalogModel[]): ChannelModel[] {
  return models.map((model) => ({
    id: model.slug, name: model.display_name, enabled: true, source: 'fetched', reasoning: codexCatalogReasoning(model),
  }))
}

/** 文件名只含账号指纹，文件只含白名单元数据，不持久化 token 或服务端提示词。 */
export function codexCatalogCachePath(credentials: CodexOAuthCredentials, directory = getConfigDir()): string {
  const identity = credentials.accountId ? `account:${credentials.accountId}` : `credential:${credentials.refresh}`
  return join(directory, `codex-models-${createHash('sha256').update(identity).digest('hex')}.json`)
}

export function readCodexModelCatalog(credentials: CodexOAuthCredentials, directory?: string): CodexCatalogModel[] {
  try {
    return parseCodexModelCatalog(readJsonFileSafe(codexCatalogCachePath(credentials, directory)))
  } catch {
    return []
  }
}

/** 请求 Codex 订阅目录，不能用 OpenAI API Key 的 /v1/models 替代。 */
export async function fetchCodexModelCatalog(
  credentials: CodexOAuthCredentials,
  fetchFn: typeof globalThis.fetch,
  directory?: string,
): Promise<CodexCatalogModel[]> {
  const url = new URL('https://chatgpt.com/backend-api/codex/models')
  url.searchParams.set('client_version', pkg.version)
  const response = await fetchFn(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${credentials.access}`,
      Accept: 'application/json',
      'User-Agent': getPromaUserAgent(pkg.version),
      ...(credentials.accountId && { 'ChatGPT-Account-Id': credentials.accountId }),
    },
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(response.status === 401 || response.status === 403
      ? `Codex 模型目录认证或权限失败（HTTP ${response.status}），请重新登录后重试`
      : `Codex 模型目录拉取失败（HTTP ${response.status}），请稍后重试`)
  }
  const models = parseCodexModelCatalog(await response.json())
  writeJsonFileAtomic(codexCatalogCachePath(credentials, directory), { models, fetchedAt: Date.now() }, true)
  return models
}
