import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tempHome = ''
const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
  shell: { openExternal: async () => undefined },
}))

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'proma-agent-capability-store-'))
  process.env.HOME = tempHome
  process.env.USERPROFILE = tempHome
  process.env.PROMA_DEV = '0'
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  rmSync(tempHome, { recursive: true, force: true })
})

describe('Global Agent Capability Store', () => {
  test('Given 不可信配置 When 规范化 Then 只保留全局目录与非敏感 MCP 定义', async () => {
    const { normalizeGlobalAgentCapabilityConfig } = await import('./agent-capability-store')
    const skillDir = join(tempHome, '.proma', 'agent-capabilities', 'skills', 'review')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: review\n---\n', 'utf8')

    const normalized = normalizeGlobalAgentCapabilityConfig({
      enabled: true,
      profile: {
        skills: [
          { id: 'global:skill:review', slug: 'review', directory: skillDir, defaultEnabled: true },
          { id: 'outside', slug: 'outside', directory: tempHome, defaultEnabled: true },
        ],
        mcpServers: [{
          id: 'global:mcp:search',
          name: 'search',
          defaultEnabled: true,
          server: {
            type: 'http',
            url: 'https://mcp.example.test',
            enabled: true,
            headers: { Authorization: 'secret' },
            env: { API_KEY: 'secret' },
          },
        }],
        instructions: [],
        toolPolicy: { requiredDeniedTools: ['DangerousDelete', 'DangerousDelete'] },
      },
    })

    expect(normalized.profile.skills.map((item) => item.id)).toEqual(['global:skill:review'])
    expect(normalized.profile.mcpServers[0]?.server.headers).toBeUndefined()
    expect(normalized.profile.mcpServers[0]?.server.env).toBeUndefined()
    expect(normalized.profile.toolPolicy.requiredDeniedTools).toEqual(['DangerousDelete'])
  })

  test('Given Project Overlay When 规范化 Then 去重并限制 Instruction 内容', async () => {
    const { normalizeAgentCapabilityOverlay } = await import('./agent-capability-store')
    const overlay = normalizeAgentCapabilityOverlay({
      inheritGlobal: false,
      skills: { enable: ['global:skill:a', 'global:skill:a'], disable: [42] },
      instructions: { add: [{ id: 'project-note', text: '  项目规则  ' }, { id: '../bad', text: 'bad' }] },
      toolPolicy: { deny: ['Bash', 'Bash'] },
    })
    expect(overlay).toEqual({
      inheritGlobal: false,
      skills: { enable: ['global:skill:a'] },
      instructions: { add: [{ id: 'project-note', text: '项目规则' }] },
      toolPolicy: { allow: [], deny: ['Bash'] },
    })
  })

  test('Given 项目 Skill/MCP When 用户显式 Promote Then 原子保存 Global 定义与 Project Overlay', async () => {
    const { createAgentWorkspace, saveWorkspaceMcpConfig } = await import('./agent-workspace-manager')
    const { getWorkspaceSkillsDir } = await import('./config-paths')
    const { promoteAgentCapability, getGlobalAgentCapabilityConfig, getProjectAgentCapabilityOverlay, removeGlobalAgentCapability, saveGlobalAgentCapabilityConfig } = await import('./agent-capability-store')
    const workspace = await createAgentWorkspace({ name: 'Capability Project' })
    const skillDir = join(getWorkspaceSkillsDir(workspace.slug), 'review')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: review\n---\nReview.', 'utf8')
    saveWorkspaceMcpConfig(workspace.slug, {
      servers: {
        search: {
          type: 'http',
          url: 'https://mcp.example.test',
          enabled: true,
          headers: { Authorization: 'legacy-secret' },
        },
      },
    })

    promoteAgentCapability({ workspaceSlug: workspace.slug, kind: 'skill', projectCapabilityId: `workspace:${workspace.slug}:skill:review` })
    promoteAgentCapability({ workspaceSlug: workspace.slug, kind: 'mcp', projectCapabilityId: `workspace:${workspace.slug}:mcp:search` })

    const config = getGlobalAgentCapabilityConfig()
    const overlay = getProjectAgentCapabilityOverlay(workspace.slug)
    expect(config.profile.skills.map((item) => item.id)).toContain('global:skill:review')
    expect(existsSync(join(config.profile.skills[0]!.directory, 'SKILL.md'))).toBe(true)
    expect(config.profile.mcpServers[0]?.server.headers).toBeUndefined()
    expect(overlay.skills).toEqual({
      enable: ['global:skill:review'],
      disable: [`workspace:${workspace.slug}:skill:review`],
    })
    expect(overlay.mcpServers).toEqual({
      enable: ['global:mcp:search'],
      disable: [`workspace:${workspace.slug}:mcp:search`],
    })
    expect(readFileSync(join(tempHome, '.proma', 'agent-capabilities.json'), 'utf8')).not.toContain('legacy-secret')
    const { getAgentCapabilityManagementSnapshot } = await import('./agent-capability-management')
    const workspaceSnapshot = getAgentCapabilityManagementSnapshot().workspaces.find((item) => item.workspace.slug === workspace.slug)
    expect(workspaceSnapshot?.effective.skills.find((item) => item.id === 'global:skill:review')?.resolution.enabled).toBe(true)
    expect(workspaceSnapshot?.migrationCandidates).toEqual([])

    saveGlobalAgentCapabilityConfig({ ...config, enabled: false })
    const rolledBack = getAgentCapabilityManagementSnapshot().workspaces.find((item) => item.workspace.slug === workspace.slug)
    expect(rolledBack?.effective.skills.find((item) => item.id === `workspace:${workspace.slug}:skill:review`)?.resolution.enabled).toBe(true)
    saveGlobalAgentCapabilityConfig({ ...config, enabled: true })

    saveGlobalAgentCapabilityConfig({
      ...config,
      profile: {
        ...config.profile,
        skills: config.profile.skills.map((item) => item.id === 'global:skill:review'
          ? { ...item, required: true }
          : item),
      },
    })
    expect(() => removeGlobalAgentCapability({ kind: 'skill', id: 'global:skill:review' })).toThrow('Required 全局能力不能移除')
    saveGlobalAgentCapabilityConfig({ ...config, enabled: true })

    removeGlobalAgentCapability({ kind: 'skill', id: 'global:skill:review' })
    expect(getProjectAgentCapabilityOverlay(workspace.slug).skills).toBeUndefined()
    expect(() => removeGlobalAgentCapability({ kind: 'skill', id: 'global:skill:missing' })).toThrow('待移除的全局能力不存在')
  })
})
