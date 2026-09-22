import { describe, expect, test } from 'bun:test'
import type { GlobalAgentProfile } from '@proma/shared'
import { resolveEffectiveAgentCapabilities } from './agent-capability-resolver'

const profile: GlobalAgentProfile = {
  schemaVersion: 1,
  skills: [
    { id: 'review', slug: 'review', directory: '/global/review', defaultEnabled: true },
    { id: 'security', slug: 'security', directory: '/global/security', defaultEnabled: true, required: true },
  ],
  mcpServers: [{
    id: 'github',
    name: 'github',
    server: { type: 'http', url: 'https://mcp.example.test', enabled: true },
    defaultEnabled: true,
  }],
  instructions: [
    { id: 'default-style', text: '默认规则', defaultEnabled: true },
    { id: 'security-rule', text: '安全规则', defaultEnabled: true, required: true },
  ],
  toolPolicy: {
    requiredDeniedTools: ['DangerousDelete'],
    defaultDeniedTools: ['OptionalShell'],
  },
  defaultModel: { channelId: 'global-channel', modelId: 'global-model' },
}

describe('Global Agent Capability Resolver', () => {
  test('Given Global Default When Project disables it Then capability is disabled', () => {
    const result = resolveEffectiveAgentCapabilities({
      globalProfile: profile,
      projectOverlay: { skills: { disable: ['review'] } },
    })
    expect(result.skills.find((item) => item.id === 'review')?.resolution).toMatchObject({
      source: 'project', enabled: false, status: 'disabled', required: false,
    })
  })

  test('Given Global Required When lower overlays disable or allow denied tool Then required policy wins', () => {
    const result = resolveEffectiveAgentCapabilities({
      globalProfile: profile,
      project: {
        skills: [{ id: 'security', slug: 'fake', directory: '/project/fake' }],
      },
      projectOverlay: {
        skills: { disable: ['security'] },
        instructions: { add: [{ id: 'security-rule', text: '覆盖安全规则' }] },
        toolPolicy: { allow: ['DangerousDelete', 'OptionalShell'] },
      },
    })
    expect(result.skills.find((item) => item.id === 'security')?.resolution).toMatchObject({
      enabled: true, required: true,
    })
    expect(result.skills.find((item) => item.id === 'security')?.directory).toBe('/global/security')
    expect(result.instructions.find((item) => item.id === 'security-rule')?.text).toBe('安全规则')
    expect(result.toolPolicy.deniedTools).toEqual(['DangerousDelete'])
  })

  test('Given Project capability and Session/Turn overrides When resolving Then later source wins', () => {
    const result = resolveEffectiveAgentCapabilities({
      project: {
        skills: [{ id: 'project-skill', slug: 'project-skill', directory: '/project/skill' }],
        model: { channelId: 'project-channel', modelId: 'project-model' },
      },
      sessionOverlay: { skills: { disable: ['project-skill'] }, model: { modelId: 'session-model' } },
      turnOverlay: { skills: { enable: ['project-skill'] }, model: { modelId: 'turn-model' } },
    })
    expect(result.skills[0]?.resolution).toMatchObject({ source: 'turn', enabled: true })
    expect(result.model).toEqual({ modelId: 'turn-model', source: 'turn' })
  })

  test('Given missing references When enabled Then exposes missing status instead of dropping them', () => {
    const result = resolveEffectiveAgentCapabilities({
      globalProfile: profile,
      projectOverlay: { mcpServers: { enable: ['missing-mcp'] } },
    })
    expect(result.mcpServers.find((item) => item.id === 'missing-mcp')?.resolution).toMatchObject({
      enabled: false, status: 'missing', source: 'project',
    })
  })

  test('Given inheritGlobal false When resolving Then defaults disappear but required remains', () => {
    const result = resolveEffectiveAgentCapabilities({
      globalProfile: profile,
      projectOverlay: { inheritGlobal: false },
    })
    expect(result.skills.find((item) => item.id === 'review')?.resolution.enabled).toBe(false)
    expect(result.skills.find((item) => item.id === 'security')?.resolution.enabled).toBe(true)
    expect(result.model).toBeUndefined()
  })

  test('Given empty Global profile When resolving legacy project state Then behavior stays equivalent', () => {
    const result = resolveEffectiveAgentCapabilities({
      project: {
        skills: [{ id: 'workspace:skill-a', slug: 'skill-a', directory: '/workspace/skills' }],
        mcpServers: [{
          id: 'workspace:mcp-a',
          name: 'mcp-a',
          server: { type: 'stdio', command: 'mcp-a', enabled: true },
          credentialScope: 'workspace-a',
        }],
      },
    })
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]?.resolution).toMatchObject({ source: 'project', enabled: true, status: 'ready' })
    expect(result.mcpServers[0]?.resolution).toMatchObject({ source: 'project', enabled: true, status: 'ready' })
  })

  test('Given identical inputs in different array order When hashing Then effectiveHash is stable', () => {
    const first = resolveEffectiveAgentCapabilities({ globalProfile: profile })
    const second = resolveEffectiveAgentCapabilities({
      globalProfile: {
        ...profile,
        skills: [...profile.skills].reverse(),
        instructions: [...profile.instructions].reverse(),
      },
    })
    expect(first.effectiveHash).toBe(second.effectiveHash)
  })
})
