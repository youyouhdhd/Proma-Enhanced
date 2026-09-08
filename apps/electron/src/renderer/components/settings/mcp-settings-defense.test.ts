/**
 * MCP 设置页渲染层防御函数测试（修复文档 TC-BLANK-04/06 + §14-§16）
 */
import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_MCP_CONFIG,
  FALLBACK_TUNNEL_STATE,
  getMcpApiCapabilities,
  isBridgeOutdated,
  normalizeRendererMcpConfig,
  normalizeTunnelState,
  REQUIRED_MCP_BRIDGE_VERSION,
} from './mcp-settings-defense.ts'

describe('normalizeRendererMcpConfig（TC-BLANK-04）', () => {
  it('空对象 / undefined → workspaces/profiles 必为空数组，tools/auth 补齐', () => {
    const empty = normalizeRendererMcpConfig({})
    expect(empty.workspaces).toEqual([])
    expect(empty.profiles).toEqual([])
    expect(empty.tools.fileRead).toBe(true)
    expect(empty.auth.type).toBe('none')
    const fallback = normalizeRendererMcpConfig(undefined)
    expect(fallback).toEqual(DEFAULT_MCP_CONFIG)
  })

  it('保留合法字段，仅补齐缺失字段', () => {
    const result = normalizeRendererMcpConfig({
      enabled: true,
      port: 8787,
      accessMode: 'full',
      workspaces: [{ id: 'ws_a', agentWorkspaceId: 'agent-a', enabled: true, permissions: { read: true, write: false, shell: false }, createdAt: 1 }],
    })
    expect(result.enabled).toBe(true)
    expect(result.port).toBe(8787)
    expect(result.accessMode).toBe('full')
    expect(result.workspaces).toHaveLength(1)
    expect(result.profiles).toEqual([])
  })
})

describe('normalizeTunnelState（TC-BLANK-06）', () => {
  it('新结构原样保留并补齐 client', () => {
    const state = normalizeTunnelState({
      phase: 'connected',
      client: { installed: true, version: 'v1.0.0', path: 'C:/t/tunnel-client.exe', source: 'managed' },
      localMcpReady: true,
      runtimeKeyConfigured: true,
    })
    expect(state.phase).toBe('connected')
    expect(state.client.installed).toBe(true)
    expect(state.client.version).toBe('v1.0.0')
  })

  it('旧结构 { status, clientInstalled } 迁移为 phase/client', () => {
    const legacy = normalizeTunnelState({ status: 'running', clientInstalled: true })
    expect(legacy.phase).toBe('connected')
    expect(legacy.client.installed).toBe(true)
    const legacyStopped = normalizeTunnelState({ status: 'stopped', clientInstalled: false })
    expect(legacyStopped.phase).toBe('stopped')
    expect(legacyStopped.client.installed).toBe(false)
  })

  it('完全无法识别的输入 → 安全回退，JSX 不会访问 undefined', () => {
    const garbage = normalizeTunnelState('garbage')
    expect(garbage).toEqual(FALLBACK_TUNNEL_STATE)
    expect(normalizeTunnelState(null).client.installed).toBe(false)
    expect(normalizeTunnelState(42).phase).toBe('stopped')
  })
})

describe('preload 能力检测（TC-BLANK-03 + §24）', () => {
  it('bun 环境无 window → 全部能力缺失但不抛错', () => {
    const capabilities = getMcpApiCapabilities()
    expect(capabilities.bridgeVersion).toBeNull()
    expect(capabilities.stateEvents).toBe(false)
    expect(capabilities.getState).toBe(false)
  })

  it('bridge 版本判定：无法读取视为兼容，过旧时要求 ≥ 9', () => {
    expect(isBridgeOutdated({ bridgeVersion: null, getState: false, stateEvents: false, installClient: false, detectClient: false, doctor: false, saveConfig: false, pickExecutable: false })).toBe(false)
    expect(isBridgeOutdated({ bridgeVersion: 2, getState: false, stateEvents: false, installClient: false, detectClient: false, doctor: false, saveConfig: false, pickExecutable: false })).toBe(true)
    expect(REQUIRED_MCP_BRIDGE_VERSION).toBe(9)
  })
})
