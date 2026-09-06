/**
 * MCP Server 配置规范化测试：多 Workspace 注册表 + 旧单工作区迁移 + Profile 校验。
 */
import { describe, expect, it } from 'bun:test'
import { normalizePromaMcpServerConfig, deriveWorkspaceId, DEFAULT_PROMA_MCP_SERVER_CONFIG } from './config.ts'

describe('normalizePromaMcpServerConfig（多工作区）', () => {
  it('空输入返回安全默认值（read-only、shell 关、空注册表）', () => {
    const config = normalizePromaMcpServerConfig(undefined)
    expect(config).toEqual(DEFAULT_PROMA_MCP_SERVER_CONFIG)
  })

  it('deriveWorkspaceId 确定性：同输入同输出，不同输入不同输出', () => {
    expect(deriveWorkspaceId('agent-1')).toBe(deriveWorkspaceId('agent-1'))
    expect(deriveWorkspaceId('agent-1')).not.toBe(deriveWorkspaceId('agent-2'))
    expect(deriveWorkspaceId('agent-1')).toMatch(/^ws_[0-9a-f]{8}$/)
  })

  it('旧单工作区配置迁移：workspaceId 合并为 workspaces[0]，权限从 accessMode 派生', () => {
    const legacy = { enabled: true, port: 'auto', workspaceId: 'agent-legacy', accessMode: 'full', tools: { fileWrite: true, shell: true } }
    const config = normalizePromaMcpServerConfig(legacy)
    expect(config.workspaces).toHaveLength(1)
    expect(config.workspaces[0]!.agentWorkspaceId).toBe('agent-legacy')
    expect(config.workspaces[0]!.id).toBe(deriveWorkspaceId('agent-legacy'))
    expect(config.workspaces[0]!.permissions).toEqual({ read: true, write: true, shell: true })
  })

  it('旧配置 read-only 模式迁移：write/shell 默认关闭', () => {
    const config = normalizePromaMcpServerConfig({ workspaceId: 'agent-ro' })
    expect(config.workspaces[0]!.permissions).toEqual({ read: true, write: false, shell: false })
  })

  it('workspaces 条目规范化：未知输入剔除、权限按最小化收口、缺 id 派生', () => {
    const config = normalizePromaMcpServerConfig({
      workspaces: [
        { agentWorkspaceId: 'agent-a', permissions: { read: true, write: true, shell: true } },
        'garbage',
        { agentWorkspaceId: 'agent-b', enabled: false },
      ],
    })
    expect(config.workspaces).toHaveLength(2)
    expect(config.workspaces[0]!.id).toBe(deriveWorkspaceId('agent-a'))
    expect(config.workspaces[0]!.permissions).toEqual({ read: true, write: true, shell: true })
    expect(config.workspaces[1]!.enabled).toBe(false)
    expect(config.workspaces[1]!.permissions).toEqual({ read: true, write: false, shell: false })
  })

  it('同一 agentWorkspaceId 去重（后写覆盖）', () => {
    const config = normalizePromaMcpServerConfig({
      workspaces: [
        { id: 'ws_x', agentWorkspaceId: 'agent-a', enabled: true },
        { id: 'ws_y', agentWorkspaceId: 'agent-a', enabled: false },
      ],
    })
    expect(config.workspaces).toHaveLength(1)
    expect(config.workspaces[0]!.id).toBe('ws_y')
    expect(config.workspaces[0]!.enabled).toBe(false)
  })

  it('profiles 校验：缺 id/name/workspaceIds 的条目剔除', () => {
    const config = normalizePromaMcpServerConfig({
      profiles: [
        { id: 'work', name: 'Work', workspaceIds: ['ws_a'], enabled: true },
        { id: 'bad' },
        'nope',
      ],
    })
    expect(config.profiles).toHaveLength(1)
    expect(config.profiles[0]!.id).toBe('work')
  })
})
