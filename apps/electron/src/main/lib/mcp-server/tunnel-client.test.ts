/**
 * OpenAI Tunnel Client Manager / Adapter 测试（TC-TUNNEL-01 ~ TC-TUNNEL-06 核心）
 * 全部使用注入的 fake spawnSync，不执行真实程序。
 */
import { describe, expect, it } from 'bun:test'
import { TunnelClientManager, executableName } from './tunnel-client-manager.ts'
import { OpenAiTunnelClientAdapter, parseVersionOutput, classifyClientFailure } from './tunnel-client-adapter.ts'
import { classifyConnectorConclusion, parseDoctorChecks } from './tunnel-doctor-parser.ts'
import { TunnelProcessRunner } from './tunnel-process-runner.ts'
import { computeMethodStats } from './protocol/request-trace.ts'
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

  it('TC-V6-DOC：doctor 参数含临时健康监听；开启本机认证时注入 extra-headers', () => {
    const base = { tunnelId: 'tunnel_abc', mcpServerUrl: 'http://127.0.0.1:8787/mcp', healthListenAddr: '127.0.0.1:0', healthUrlFile: 'C:\tmp\d.txt' }
    const doctorArgs = adapter.buildDoctorArgs(base)
    expect(doctorArgs.join(' ')).toContain('--health.listen-addr 127.0.0.1:0')
    expect(doctorArgs.join(' ')).toContain('--health.url-file')
    expect(doctorArgs.join(' ')).not.toContain('extra-headers')
    const authedArgs = adapter.buildDoctorArgs({ ...base, localMcpAuth: { type: 'bearer', envVarName: 'PROMA_MCP_AUTH_HEADER' } })
    expect(authedArgs.join(' ')).toContain('--mcp.extra-headers Authorization: env:PROMA_MCP_AUTH_HEADER')
    expect(authedArgs.join(' ')).toContain('--mcp.discovery-extra-headers Authorization: env:PROMA_MCP_AUTH_HEADER')
  })

  it('TC-V6-DOC-PARSER：官方真实 Check ID 正确映射，不再出现虚构 unknown', () => {
    const officialOutput = [
      'CHECK config_source            PASS flags/environment only',
      'CHECK profile_load             PASS flags/environment only',
      'CHECK tunnel_id                PASS tunnel_abc',
      'CHECK control_plane_api_key    PASS env:CONTROL_PLANE_API_KEY',
      'CHECK mcp_target               PASS http://127.0.0.1:47097/mcp',
      'CHECK mcp_server_reachable     PASS HTTP 401 from http://127.0.0.1:47097/mcp',
      'CHECK oauth_metadata           PASS OAuth metadata not advertised',
      'CHECK health_listener          FAIL listen tcp 127.0.0.1:8080 bind conflict',
      'CHECK ui                       SKIP blocked by health listener check',
      'CHECK codex_plugin             SKIP not installed',
      'RESULT fail',
    ].join('\n')
    const result = adapter.parseDoctor({ exitCode: 2, stdout: officialOutput, stderr: '' }, 'v0.0.14')
    const names = result.checks.map((c) => c.name)
    expect(names).toContain('Tunnel ID')
    expect(names).toContain('Runtime API Key')
    expect(names).toContain('PROMA MCP 可达性')
    expect(names).toContain('Tunnel 本地健康服务')
    // 不再出现 V5 时期虚构的 Check（TC-V6-DOC-PARSER）
    expect(names).not.toContain('tunnel')
    expect(names).not.toContain('control_plane_connection')
    expect(names).not.toContain('mcp_server')
    expect(names).not.toContain('secure_tunnel_ready')
    // health_listener FAIL 是阻断项；codex_plugin SKIP 不阻断
    expect(result.blockingFailures).toContain('Tunnel 本地健康服务')
    expect(result.blockingFailures).not.toContain('Codex Tunnel 插件')
    const codex = result.checks.find((c) => c.name === 'Codex Tunnel 插件')
    expect(codex?.state).toBe('skipped')
    expect(result.ok).toBe(false)
  })

  it('TC-V6/V7-DIAG：Connector 结论归类 A / B-AUTH / B-DISCOVER / B-HANDSHAKE / B-PROTOCOL / C / OK', () => {
    expect(classifyConnectorConclusion({ recentCount: 0, allRejected: false, discoverCount: 0, discoverOk: false, toolsListCount: 0, toolsListOk: false, doctorOk: true })!.id).toBe('A')
    expect(classifyConnectorConclusion({ recentCount: 3, allRejected: true, discoverCount: 3, discoverOk: false, toolsListCount: 0, toolsListOk: false, doctorOk: true })!.id).toBe('B-AUTH')
    expect(classifyConnectorConclusion({ recentCount: 3, allRejected: false, discoverCount: 0, discoverOk: false, toolsListCount: 2, toolsListOk: false, doctorOk: true })!.id).toBe('B-PROTOCOL')
    expect(classifyConnectorConclusion({ recentCount: 3, allRejected: false, discoverCount: 0, discoverOk: false, toolsListCount: 2, toolsListOk: true, doctorOk: false })!.id).toBe('C')
    expect(classifyConnectorConclusion({ recentCount: 3, allRejected: false, discoverCount: 0, discoverOk: false, toolsListCount: 2, toolsListOk: true, doctorOk: true })!.id).toBe('OK')
  })

  it('TC-V6-KEY：runner env 注入 CONTROL_PLANE_API_KEY 与 PROMA_MCP_AUTH_HEADER（不进 argv）', () => {
    const runner = new TunnelProcessRunner()
    const env = runner.buildTunnelClientEnv({ runtimeKey: 'rk-1234567890', localMcpBearerToken: 'local-abcdef' })
    expect(env.CONTROL_PLANE_API_KEY).toBe('rk-1234567890')
    expect(env.PROMA_MCP_AUTH_HEADER).toBe('Bearer local-abcdef')
  })

  it('computeMethodStats：方法直方图与分类计数（V7 §6）', () => {
    const stats = computeMethodStats([
      { requestKind: 'mcp-rpc', requestSource: 'connector-forwarded', at: 1, method: 'POST', path: '/mcp', hasSessionId: false, jsonRpcMethod: 'server/discover', statusCode: 404 },
      { requestKind: 'mcp-rpc', requestSource: 'connector-forwarded', at: 2, method: 'POST', path: '/mcp', hasSessionId: false, jsonRpcMethod: 'server/discover', statusCode: 200 },
      { requestKind: 'mcp-rpc', requestSource: 'connector-forwarded', at: 3, method: 'POST', path: '/mcp', hasSessionId: false, jsonRpcMethod: 'tools/list', statusCode: 200 },
      { requestKind: 'mcp-rpc', requestSource: 'connector-forwarded', at: 4, method: 'POST', path: '/mcp', hasSessionId: false, jsonRpcMethod: 'tools/call', statusCode: 200 },
      { requestKind: 'oauth-probe', requestSource: 'unknown', at: 5, method: 'GET', path: '/mcp', hasSessionId: false, statusCode: 405 },
    ])
    expect(stats.total).toBe(5)
    expect(stats.discoverCount).toBe(2)
    expect(stats.toolsListCount).toBe(1)
    expect(stats.toolsCallCount).toBe(1)
    expect(stats.methods['server/discover']).toBe(2)
    expect(stats.statuses['200']).toBe(3)
    expect(stats.statuses['405']).toBe(1)
    expect(stats.unknownCount).toBe(0)
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
