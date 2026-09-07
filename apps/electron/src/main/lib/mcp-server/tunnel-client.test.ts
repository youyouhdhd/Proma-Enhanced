/**
 * OpenAI Tunnel Client Manager / Adapter 测试（TC-TUNNEL-01 ~ TC-TUNNEL-06 核心）
 * 全部使用注入的 fake spawnSync，不执行真实程序。
 */
import { describe, expect, it } from 'bun:test'
import { TunnelClientManager, executableName } from './tunnel-client-manager.ts'
import { OpenAiTunnelClientAdapter, parseVersionOutput, classifyClientFailure } from './tunnel-client-adapter.ts'
import type { TunnelManagerDeps } from './tunnel-client-types.ts'

function makeDeps(overrides?: Partial<TunnelManagerDeps>): TunnelManagerDeps & { calls: Array<{ executable: string; args: string[] }> } {
  const calls: Array<{ executable: string; args: string[] }> = []
  return {
    calls,
    spawnSync: (executable, args, options) => {
      calls.push({ executable, args })
      void options
      return { status: 0, stdout: 'tunnel-client 1.0.0', stderr: '' }
    },
    exists: () => true,
    isFile: () => true,
    readdir: () => [],
    configDir: () => 'C:\\Users\\u\\.proma',
    ...overrides,
  }
}

describe('TunnelClientManager（程序解析与检测）', () => {
  it('TC-TUNNEL-04：拒绝网络 URL，不下载不执行', () => {
    const manager = new TunnelClientManager(makeDeps())
    const result = manager.validateExecutableInput('https://example.com/tunnel-client.exe')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('TUNNEL_CLIENT_PATH_INVALID')
      expect(result.message).toContain('本地程序位置')
    }
  })

  it('TC-TUNNEL-06：PATH 中不存在 client（ENOENT）→ installed=false，绝不误判 true', () => {
    const deps = makeDeps({
      spawnSync: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn failed'), { code: 'ENOENT' }) }),
    })
    const manager = new TunnelClientManager(deps)
    const detection = manager.detectAt(executableName(), 'system-path')
    expect(detection.installed).toBe(false)
    expect(detection.errorCode).toBe('TUNNEL_CLIENT_PATH_INVALID')
  })

  it('版本检测：--version 退出码非 0 → 不可用；成功则解析版本', () => {
    const failDeps = makeDeps({ spawnSync: () => ({ status: 1, stdout: 'not a client', stderr: '' }) })
    const failManager = new TunnelClientManager(failDeps)
    expect(failManager.detectAt('C:\\t\\tunnel-client.exe', 'custom').installed).toBe(false)

    const okManager = new TunnelClientManager(makeDeps())
    const ok = okManager.detectAt('C:\\t\\tunnel-client.exe', 'custom')
    expect(ok.installed).toBe(true)
    expect(ok.version).toBe('v1.0.0')
    expect(ok.path).toBe('C:\\t\\tunnel-client.exe')
    // 必须直接 spawn 可执行文件 + --version，无 shell 包裹
    expect(okManager['deps'].calls[0]!.args).toEqual(['--version'])
  })

  it('TC-TUNNEL-05：custom-path 指向不存在的文件 → 明确错误', () => {
    const deps = makeDeps({ exists: () => false })
    const manager = new TunnelClientManager(deps)
    const detection = manager.detect({ mode: 'custom-path', executablePath: 'C:\\Tools\\tunnel-client.exe' })
    expect(detection.installed).toBe(false)
    expect(detection.errorMessage).toContain('找不到')
  })

  it('managed 目录扫描：无版本目录 → 尚未安装（TC-TUNNEL-01）', () => {
    const manager = new TunnelClientManager(makeDeps({ readdir: () => [] }))
    const detection = manager.detect({ mode: 'managed' })
    expect(detection.installed).toBe(false)
    expect(detection.errorCode).toBe('TUNNEL_CLIENT_NOT_INSTALLED')
  })

  it('TC-TUNNEL-03：路径包含空格原样传递，不依赖用户加引号', () => {
    const deps = makeDeps()
    const manager = new TunnelClientManager(deps)
    const spaced = 'C:\\My Tools\\OpenAI Tunnel\\tunnel-client.exe'
    const detection = manager.detectAt(spaced, 'custom')
    expect(detection.installed).toBe(true)
    expect(deps.calls[0]!.executable).toBe(spaced)
  })
})

describe('OpenAiTunnelClientAdapter（CLI 契约）', () => {
  const adapter = new OpenAiTunnelClientAdapter()

  it('run 参数由 Adapter 统一构造，Key 不进 argv', () => {
    const args = adapter.buildRunArgs({ tunnelId: 'tunnel_abc', mcpServerUrl: 'http://127.0.0.1:8787/mcp', healthListenAddr: '127.0.0.1:0', healthUrlFile: 'C:\\tmp\\h.txt' })
    expect(args[0]).toBe('run')
    expect(args.join(' ')).toContain('--control-plane.tunnel-id tunnel_abc')
    expect(args.join(' ')).toContain('--mcp.server-url http://127.0.0.1:8787/mcp')
    expect(args.join(' ')).toContain('--health.url-file')
    expect(args.join(' ').toLowerCase()).not.toContain('control_plane_api_key')
  })

  it('parseVersion 从 --version 输出提取语义化版本', () => {
    expect(parseVersionOutput('tunnel-client 1.2.3')).toBe('v1.2.3')
    expect(parseVersionOutput('v2.0.0-beta.1')).toBe('v2.0.0-beta.1')
    expect(parseVersionOutput('unknown output')).toBeUndefined()
  })

  it('parseDoctor：退出码 0 → ok；关键词归因到稳定错误码', () => {
    const ok = adapter.parseDoctor({ exitCode: 0, stdout: 'all checks passed', stderr: '' })
    expect(ok.ok).toBe(true)
    const unauthorized = classifyClientFailure('error: unauthorized api key')
    expect(unauthorized?.code).toBe('RUNTIME_KEY_UNAUTHORIZED')
    const network = classifyClientFailure('ECONNREFUSED 1.2.3.4')
    expect(network?.code).toBe('NETWORK_UNREACHABLE')
  })
})
