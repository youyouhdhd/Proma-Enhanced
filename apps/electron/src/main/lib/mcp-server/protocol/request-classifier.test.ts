import { describe, expect, it } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { PromaMcpRequestTrace } from '@proma/shared'
import { classifyRequest, isMcpJsonRpc } from './request-classifier'
import { tunnelOAuthProbe } from './fixtures/tunnel-oauth-probe'
import { withMcpServer } from './test-fixture'
import { analyzeProtocol, isConnectorRpc, rpcSucceeded } from './protocol-negotiation'
import { classifyConnectorConclusion } from '../tunnel-doctor-parser'
import { formatProtocolExport } from '../../../../renderer/components/settings/mcp-protocol-export'
import { getTunnelLogUrl } from '../tunnel-log-url'

function conclusion(traces: PromaMcpRequestTrace[]) {
  const rpc = traces.filter(isConnectorRpc)
  const protocol = analyzeProtocol(traces, true)
  return classifyConnectorConclusion({ protocol, recentCount: rpc.length,
    allRejected: rpc.some((t) => t.statusCode === 401 || t.statusCode === 403),
    discoverCount: rpc.filter((t) => t.jsonRpcMethod === 'server/discover').length,
    discoverOk: rpc.some((t) => t.jsonRpcMethod === 'server/discover' && rpcSucceeded(t) && t.discoverValidated),
    toolsListCount: rpc.filter((t) => t.jsonRpcMethod === 'tools/list').length,
    toolsListOk: protocol.toolDiscovery?.ok ?? false, doctorOk: false })
}

describe('V9 请求归因与探测隔离', () => {
  it('Given 文档空 POST fixture When 不带来源标记 Then 400 且不进入 era router', async () => {
    await withMcpServer(async (server, endpoint) => {
      const response = await fetch(endpoint, { method: 'POST', headers: { accept: 'application/json' } })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'MCP request body required' })
      const trace = server.getStatus().recentRequests.at(-1)!
      expect(trace.requestKind).toBe('oauth-probe')
      expect(trace.requestSource).toBe('unknown')
      expect(trace.protocolEra).toBeUndefined()
      expect(trace.requestMetadata?.contentType).toBeUndefined()
      expect(server.getStatus().activeSessions).toBe(0)
    })
  })

  it('Given 10 条 probe 形状与官方 UA When 诊断 Then A-UPSTREAM 且 Connector 406 为零', async () => {
    await withMcpServer(async (server, endpoint) => {
      for (const index of [0, 1, 1, 2, 3, 0, 1, 1, 2, 3]) {
        const fixture = tunnelOAuthProbe[index]!
        const response = await fetch(new URL(fixture.path, endpoint), { method: fixture.method, headers: { ...fixture.headers, 'user-agent': 'oai-tunnel-client/0.0.14' } })
        await response.text()
        expect(response.status).toBe(fixture.status)
      }
      const traces = server.getStatus().recentRequests
      expect(traces.every((t) => t.requestSource === 'tunnel-client-internal' && t.protocolEra === undefined)).toBe(true)
      expect(traces.filter((t) => t.path.startsWith('/.well-known')).length).toBe(4)
      const analysis = analyzeProtocol(traces, true)
      expect(analysis.traffic).toMatchObject({ totalHttpCount: 10, connectorRpcCount: 0, internalProbeCount: 10, oauthProbeCount: 6, oauthWellKnownCount: 4 })
      expect(analysis.transport?.http406Count).toBe(0)
      expect(conclusion(traces)?.id).toBe('A-UPSTREAM')
      expect(conclusion(traces.map((t) => ({ ...t, statusCode: 406 })))?.id).toBe('A-UPSTREAM')
    })
  })

  it('Given 空/坏 JSON/非 RPC/超限 When POST Then 稳定 4xx 且不分配协议时代', async () => {
    await withMcpServer(async (server, endpoint) => {
      for (const body of ['   ', '{', '{}', 'null', '[]', '{"jsonrpc":"1.0","method":"tools/list"}', 'x'.repeat(1024 * 1024 + 1)]) {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
        await response.text()
        expect(response.status).toBe(body.length > 1024 * 1024 ? 413 : 400)
        const trace = server.getStatus().recentRequests.at(-1)!
        expect(trace.requestKind).not.toBe('mcp-rpc')
        expect(trace.protocolEra).toBeUndefined()
      }
      expect(isMcpJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(true)
    })
  })

  it('Given 旧协议 batch When 两个 RPC 共用 POST Then 保留官方 v1 batch 响应', async () => {
    await withMcpServer(async (server, endpoint) => {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace_list', arguments: {} } },
      ]) })
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body).toContain('workspace_list')
      expect(body).toContain('"id":2')
      expect(server.getStatus().recentRequests.at(-1)?.requestKind).toBe('mcp-rpc')
      expect(server.getStatus().recentRequests.at(-1)?.protocolEra).toBe('legacy')
    })
  })

  it('Given 转发 RPC When 错误 Accept 或 Bearer Then 分别归类 B-TRANSPORT / B-AUTH', async () => {
    for (const auth of [false, true]) await withMcpServer(async (server, endpoint) => {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'x-openai-session': 'never-export-session', 'content-type': 'application/json', accept: 'image/png' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
      await response.text()
      expect(response.status).toBe(auth ? 401 : 406)
      const traces = server.getStatus().recentRequests
      expect(traces.at(-1)?.requestKind).toBe('mcp-rpc')
      expect(conclusion(traces)?.id).toBe(auth ? 'B-AUTH' : 'B-TRANSPORT')
      expect(JSON.stringify(traces)).not.toContain('never-export-session')
    }, auth ? { auth: { type: 'managed-bearer' } } : {}, auth ? 'local-secret' : undefined)
  })

  it('Given 合成转发标记的官方 Client When list/call 后混入 probes Then Ready 不被 probes 阻断', async () => {
    await withMcpServer(async (server, endpoint) => {
      const client = new Client({ name: 'v9-attribution-fixture', version: '1' }, { versionNegotiation: { mode: 'auto' } })
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { 'x-openai-subject': 'never-export-subject', 'x-openai-session': 'never-export-session', 'user-agent': 'oai-tunnel-client/0.0.14' } } }))
        expect(client.getProtocolEra()).toBe('modern')
        expect((await client.listTools()).tools.length).toBeGreaterThan(0)
        expect(conclusion(server.getStatus().recentRequests)?.id).toBe('C')
        expect((await client.callTool({ name: 'workspace_list', arguments: {} })).isError).toBe(false)
        for (const fixture of tunnelOAuthProbe) await (await fetch(new URL(fixture.path, endpoint), { method: fixture.method, headers: fixture.headers })).text()
        const status = server.getStatus()
        expect(analyzeProtocol(status.recentRequests, true).connectorReady).toBe(true)
        expect(conclusion(status.recentRequests)?.id).toBe('OK')
        expect(status.recentRequests.some((t) => t.sourceSignals?.hasOpenAiSubject && t.sourceSignals?.hasOpenAiSession)).toBe(true)
        const exported = formatProtocolExport(status, null, null)
        expect(exported).toContain('connector-forwarded')
        expect(exported).not.toContain('never-export')
        expect(JSON.stringify(status)).not.toContain('never-export')
        const onlyUnknown = status.recentRequests.map((t) => ({ ...t, requestSource: 'unknown' as const }))
        expect(analyzeProtocol(onlyUnknown, true).connectorReady).toBe(false)
      } finally { await client.close() }
    })
  })

  it('Given 来源证据优先级 When 分类 Then marker 优先且 UA 不把 RPC 判为内部 probe', () => {
    const input = { method: 'POST', path: '/mcp', headers: { 'user-agent': 'oai-tunnel-client/0.0.14' }, hasMcpSessionId: false, parsedBody: { kind: 'json' as const, value: { jsonrpc: '2.0', method: 'tools/list' } } }
    expect(classifyRequest(input).source).toBe('unknown')
    expect(classifyRequest({ ...input, headers: {} }).source).toBe('local-mcp-client')
    expect(classifyRequest({ ...input, headers: { ...input.headers, 'x-openai-subject': 'never-export' } }).source).toBe('connector-forwarded')
    expect(classifyRequest({ ...input, method: 'GET', hasMcpSessionId: true }).kind).toBe('legacy-session-stream')
    expect(classifyRequest({ ...input, path: '/unrelated' }).kind).toBe('unknown-http')
  })

  it('Given 当前 health URL When 打开日志 Then 只允许本机并丢弃凭据外的附加 query', () => {
    expect(getTunnelLogUrl('http://127.0.0.1:8123/health?key=never-export')).toBe('http://127.0.0.1:8123/ui#logs')
    expect(getTunnelLogUrl('http://[::1]:8123/')).toBe('http://[::1]:8123/ui#logs')
    for (const url of [undefined, 'https://example.com', 'http://127.0.0.1.example.com', 'http://user:secret@127.0.0.1', 'file:///tmp/a', 'javascript:alert(1)']) expect(() => getTunnelLogUrl(url)).toThrow()
  })
})
