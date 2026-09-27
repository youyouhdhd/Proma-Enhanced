import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { serializeCodexCredentials } from '@proma/shared'
import { getAdapter } from '@proma/core'
import { writeJsonFileAtomic } from './safe-file'

type ChannelManagerModule = typeof import('./channel-manager')

let channelManager: ChannelManagerModule
let tempHome: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  shell: {
    openExternal: async () => undefined,
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function writeChannels(channels: unknown[], version = 2): void {
  const configDir = join(tempHome, '.proma')
  mkdirSync(configDir, { recursive: true })
  writeJsonFileAtomic(
    join(configDir, 'channels.json'),
    { version, channels },
  )
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-channel-runtime-key-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  channelManager = await import('./channel-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('渠道运行时认证解析', () => {
  test.each([5, 9])('Given schema %s 的旧套餐配置 When 读取 Then 渠道、密钥及适配器仍可用', async (version) => {
    const providers = ['opencode-go-openai', 'doubao', 'ark-coding-plan'] as const
    writeChannels(providers.map((provider) => ({
      id: provider, name: provider, provider, baseUrl: 'https://example.test', apiKey: 'retained-secret',
      models: [{ id: 'private-model', name: '自定义模型', enabled: false }], enabled: true, createdAt: 1, updatedAt: 1,
    })), version)
    for (const provider of providers) {
      expect(getAdapter(provider)).toBeDefined()
      expect(channelManager.getChannelById(provider)?.models).toContainEqual({ id: 'private-model', name: '自定义模型', enabled: false })
      await expect(channelManager.resolveChannelRuntimeApiKey(provider)).resolves.toBe('retained-secret')
    }
  })

  test('Given 小米存量模型 When 补齐 MiMo 2.6 Then 保留旧模型、名称和关闭状态且不重复添加', () => {
    writeChannels([{
      id: 'xiaomi', name: '小米', provider: 'xiaomi', baseUrl: 'https://example.test', apiKey: 'test-key',
      models: [
        { id: 'mimo-v2.5-pro', name: '旧模型', enabled: true },
        { id: 'mimo-v2.6-pro', name: '自定名称', enabled: false },
      ], enabled: true, createdAt: 1, updatedAt: 1,
    }], 5)
    const models = channelManager.getChannelById('xiaomi')?.models
    expect(models).toContainEqual({ id: 'mimo-v2.5-pro', name: '旧模型', enabled: true })
    expect(models).toContainEqual({ id: 'mimo-v2.6-pro', name: '自定名称', enabled: false })
    expect(models?.filter((model) => model.id === 'mimo-v2.6-pro')).toHaveLength(1)
    expect(models).toContainEqual({ id: 'mimo-v2.6-pro-ultraspeed', name: 'MiMo V2.6 Pro UltraSpeed', enabled: false })
    expect(channelManager.getChannelById('xiaomi')?.models).toEqual(models)
  })
  test('Given ChatGPT OAuth 渠道 When 解析运行时 key Then 返回 access token 而不是凭据 JSON', async () => {
    writeChannels([
      {
        id: 'codex-channel',
        name: 'ChatGPT',
        provider: 'openai-codex',
        baseUrl: '',
        apiKey: serializeCodexCredentials({
          access: 'oauth-access-token',
          refresh: 'oauth-refresh-token',
          expires: Date.now() + 3_600_000,
        }),
        models: [],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    await expect(channelManager.resolveChannelRuntimeApiKey('codex-channel'))
      .resolves.toBe('oauth-access-token')
  })

  test('Given 普通渠道 When 解析运行时 key Then 返回解密后的 API Key', async () => {
    writeChannels([
      {
        id: 'api-key-channel',
        name: 'Anthropic',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'plain-api-key',
        models: [],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])

    await expect(channelManager.resolveChannelRuntimeApiKey('api-key-channel'))
      .resolves.toBe('plain-api-key')
  })
})
