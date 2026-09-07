/**
 * OpenAI Tunnel Client Manager / Adapter 测试（TC-TUNNEL-01 ~ TC-TUNNEL-06 核心）
 * 全部使用注入的 fake spawnSync，不执行真实程序。
 */
import { describe, expect, it } from 'bun:test'
import { TunnelClientManager, executableName } from './tunnel-client-manager.ts'
import { OpenAiTunnelClientAdapter, parseVersionOutput, classifyClientFailure } from './tunnel-client-adapter.ts'
import { parseDoctorChecks } from './tunnel-doctor-parser.ts'
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

  it('TC-V5-KEY-03：control plane API key is required → MISSING_IN_PROCESS，不得误判为权限不足', () => {
    const failure = classifyClientFailure('CHECK control_plane_api_key FAIL control plane API key is required')
    expect(failure?.code).toBe('RUNTIME_KEY_MISSING_IN_PROCESS')
    expect(failure?.code).not.toBe('TUNNEL_PERMISSION_DENIED')
    expect(failure?.action).toContain('凭据注入')
  })

  it('TC-V5-KEY-04/05：401 → UNAUTHORIZED；403 → PERMISSION_DENIED', () => {
    expect(classifyClientFailure('http 401 unauthorized')?.code).toBe('RUNTIME_KEY_UNAUTHORIZED')
    expect(classifyClientFailure('http 403 forbidden')?.code).toBe('TUNNEL_PERMISSION_DENIED')
    expect(classifyClientFailure('permission denied for tunnel')?.code).toBe('TUNNEL_PERMISSION_DENIED')
  })

  it('TC-V5-DOC-02：官方 CHECK 行解析为三态', () => {
    const parsed = parseDoctorChecks(
      ['CHECK control_plane_api_key PASS ok', 'CHECK tunnel FAIL not found', 'CHECK mcp_server SKIP later'].join('\n'),
      '',
    )
    expect(parsed).toHaveLength(3)
    expect(parsed[0]!.state).toBe('pass')
    expect(parsed[0]!.name).toBe('Runtime API Key')
    expect(parsed[1]!.state).toBe('fail')
    expect(parsed[2]!.state).toBe('skipped')
  })

  it('TC-V5-DOC-01：exit != 0 且无 CHECK 行 → 未验证项 unknown，绝不标绿', () => {
    const result = adapter.parseDoctor({ exitCode: 2, stdout: 'some text', stderr: '' }, 'v0.0.14')
    expect(result.ok).toBe(false)
    const passStates = result.checks.filter((c) => c.state === 'pass')
    // 只有「OpenAI Tunnel Client」（--version 已验证）允许 pass；其余必须 unknown
    expect(passStates).toHaveLength(1)
    expect(passStates[0]!.name).toBe('OpenAI Tunnel Client')
  })

  it('完整 CLI 校验参数：doctor --help / run --help', () => {
    expect(adapter.buildDoctorHelpArgs()).toEqual(['doctor', '--help'])
    expect(adapter.buildRunHelpArgs()).toEqual(['run', '--help'])
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
