import { it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSharing } from './config'
import { normalizeRemoteConfig } from '../mcp-transport/config'
import { shareFolderIdentity } from './roots'

it('Given V11配置 When 迁移 Then 保留单目标/域名且不扩大写入执行权限', () => {
  const sharing = normalizeSharing({ version: 1, roots: [], enabled: true, delegation: { enabled: true, channelId: 'channel', modelId: 'model' } })
  expect(sharing.version).toBe(3)
  expect(sharing.delegation.targets[0]?.channelId).toBe('channel')
  expect(sharing.policy).toEqual({ read: 'direct', write: 'disabled', execute: 'disabled' })
  expect(sharing.delegation.action).toEqual({ mode: 'analysis', write: false, execute: false })
  const old = { version: 2, provider: 'ngrok', providers: { ngrok: { hostname: 'https://stable.ngrok.app' } } }
  expect(normalizeRemoteConfig(old, true).providers.ngrok?.authSource).toBe('proma-secret')
  expect(normalizeRemoteConfig(old, false).providers.ngrok?.authSource).toBe('system-config')
  expect(normalizeRemoteConfig(old).providers.ngrok?.hostname).toBe('https://stable.ngrok.app')
})
it('Given 文件夹与目录别名 When 计算身份 Then 同一真实目录保持一致', () => {
  const base = mkdtempSync(join(tmpdir(), 'proma-v12-identity-'))
  const root = join(base, 'long folder name'); mkdirSync(root)
  const alias = join(base, 'alias'); symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  try { expect(shareFolderIdentity(alias)).toBe(shareFolderIdentity(root)); expect(shareFolderIdentity(root)).toBe(shareFolderIdentity(root)) }
  finally { rmSync(base, { recursive: true, force: true }) }
})
