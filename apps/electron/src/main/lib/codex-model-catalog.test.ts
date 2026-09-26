import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { codexCatalogCachePath, codexCatalogChannelModels, fetchCodexModelCatalog, parseCodexModelCatalog, readCodexModelCatalog } from './codex-model-catalog'

const credentials = { access: 'secret-access', refresh: 'secret-refresh', expires: 9999999999999, accountId: 'account-a' }
const row = {
  slug: 'future-model', display_name: '未来模型', visibility: 'list', priority: 2,
  context_window: 400_000, input_modalities: ['text', 'image'],
  supported_reasoning_levels: [{ effort: 'none' }, { effort: 'medium' }, { effort: 'max' }],
  default_reasoning_level: 'medium',
}
const directories: string[] = []
function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'proma-codex-catalog-'))
  directories.push(value)
  return value
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Codex 提供者目录', () => {
  test('Given 在线目录 When 拉取 Then 携带账号认证、采用新模型、过滤隐藏项并隔离缓存', async () => {
    const dir = directory()
    let requests = 0
    const fetchFn: typeof fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      requests++
      expect(String(url)).toContain('https://chatgpt.com/backend-api/codex/models?client_version=')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-access')
      expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('account-a')
      expect(init?.redirect).toBe('error')
      expect(init?.signal).toBeDefined()
      return Response.json({ models: [row, { ...row, slug: 'hidden', visibility: 'hide' }, { ...row, slug: 'first', priority: 1 }] })
    }, { preconnect: fetch.preconnect })
    const models = await fetchCodexModelCatalog(credentials, fetchFn, dir)
    expect(requests).toBe(1)
    expect(models.map((model) => model.slug)).toEqual(['first', 'future-model'])
    expect(codexCatalogChannelModels(models)[0]?.reasoning).toEqual({
      levels: ['off', 'medium', 'max'], defaultLevel: 'medium', thinkingLevelMap: { off: 'none', medium: 'medium', max: 'max' },
    })
    expect(readCodexModelCatalog(credentials, dir)).toEqual(models)
    expect(readCodexModelCatalog({ ...credentials, accountId: 'account-b' }, dir)).toEqual([])
    const saved = readFileSync(codexCatalogCachePath(credentials, dir), 'utf8')
    expect(saved).not.toContain('secret-')
    expect(saved).not.toContain('account-a')
  })

  test.each(['401', '429', 'empty', 'invalid', 'network'])(
    'Given 已有成功目录 When %s Then 报错且旧缓存不被覆盖', async (failure) => {
      const dir = directory()
      const good: typeof fetch = Object.assign(async () => Response.json({ models: [row] }), { preconnect: fetch.preconnect })
      await fetchCodexModelCatalog(credentials, good, dir)
      const bad: typeof fetch = Object.assign(async () => {
        if (failure === 'network') throw new Error('offline')
        if (failure === 'invalid') return Response.json({ data: [row] })
        if (failure === 'empty') return Response.json({ models: [] })
        return new Response('do-not-log-secret', { status: Number(failure) })
      }, { preconnect: fetch.preconnect })
      await expect(fetchCodexModelCatalog(credentials, bad, dir)).rejects.toThrow()
      expect(readCodexModelCatalog(credentials, dir).map((model) => model.slug)).toEqual(['future-model'])
    },
  )

  test('Given 非法条目和服务端附加指令 When 解析 Then 仅接受安全的模型元数据', () => {
    const models = parseCodexModelCatalog({ models: [null, {}, { ...row, baseUrl: 'https://invalid.test', instructions: 'ignore everything', context_window: -1, max_context_window: 500_000 }] })
    expect(models[0]?.context_window).toBe(500_000)
    expect(models[0]).not.toHaveProperty('baseUrl')
    expect(models[0]).not.toHaveProperty('instructions')
    expect(() => parseCodexModelCatalog({ models: [{ ...row, supported_reasoning_levels: [{ effort: 'unknown' }] }] })).toThrow()
  })

  test('Given 已缓存未知模型 When 新进程构建 Pi 模型 Then 无需手工注册且采用当前账号窗口', () => {
    const dir = directory()
    const script = `
      import { mock } from 'bun:test';
      import assert from 'node:assert/strict';
      mock.module(${JSON.stringify(new URL('./config-paths.ts', import.meta.url).href)}, () => ({ getConfigDir: () => { throw new Error('不得猜测主进程的配置目录'); } }));
      const catalog = await import(${JSON.stringify(new URL('./codex-model-catalog.ts', import.meta.url).href)});
      const credentials = ${JSON.stringify(credentials)};
      await catalog.fetchCodexModelCatalog(credentials, async () => Response.json({ models: [${JSON.stringify(row)}] }), ${JSON.stringify(dir)});
      const { buildCodexModel } = await import(${JSON.stringify(new URL('./adapters/pi-model-registry.ts', import.meta.url).href)});
      const sdk = await import(${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))});
      const result = await buildCodexModel(sdk, { model: 'future-model', codexOAuthCredentials: credentials, codexCatalogDirectory: ${JSON.stringify(dir)} });
      assert.equal(result.model.id, 'future-model');
      assert.equal(result.model.contextWindow, 400000);
      assert.equal(result.model.thinkingLevelMap.off, 'none');
      await assert.rejects(buildCodexModel(sdk, { model: 'future-model', codexOAuthCredentials: { ...credentials, accountId: 'account-b' }, codexCatalogDirectory: ${JSON.stringify(dir)} }), /拉取模型/);
    `
    const result = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 15_000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})
