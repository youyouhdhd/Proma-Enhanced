import { describe, expect, it } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { modernMeta, withMcpServer } from './test-fixture'
import { MODERN_PROTOCOL_VERSION } from './modern-server'
import { analyzeProtocol } from './protocol-negotiation'
import { classifyConnectorConclusion } from '../tunnel-doctor-parser'

describe('V8 raw HTTP（合成 fixtures，非用户历史请求）', () => {
  it('Given modern metadata When JSON-only / 双 Accept / 不支持 Accept Then 官方 transport 决定状态且有安全原因', async () => {
    await withMcpServer(async (server, endpoint) => {
      for (const accept of ['application/json', 'application/json, text/event-stream', '*/*', 'application/json;q=0, */*;q=1', 'image/png']) {
        const response = await fetch(endpoint, { method: 'POST',
          headers: { 'content-type': 'application/json', accept, 'mcp-protocol-version': MODERN_PROTOCOL_VERSION, 'mcp-method': 'tools/list' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta } }),
        })
        await response.text()
        expect(response.status).toBe(accept === 'image/png' || accept.includes('q=0') ? 406 : 200)
        const trace = server.getStatus().recentRequests.at(-1)!
        expect(trace.jsonRpcMethod).toBe('tools/list')
        expect(trace.requestMetadata?.accept).toBe(accept)
        if (response.status === 406) {
          expect(trace.responseReason).toBe('accept-not-supported')
          expect(analyzeProtocol([trace], true).connectorReady).toBe(false)
        } else expect(trace.schemaValidated).toBe(true)
      }
    })
  })

  it('Given malformed / RPC error / Content-Type / version When response ends Then 每个请求仅一个 trace', async () => {
    await withMcpServer(async (server, endpoint) => {
      for (const [body, contentType, version] of [
        ['{', 'application/json', MODERN_PROTOCOL_VERSION],
        [JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'foo/bar', params: { _meta: modernMeta } }), 'application/json', MODERN_PROTOCOL_VERSION],
        [JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: modernMeta } }), 'text/plain', MODERN_PROTOCOL_VERSION],
        [JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: { ...modernMeta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } }), 'application/json', '2099-01-01'],
      ]) {
        const before = server.getStatus().recentRequests.length
        const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': contentType!, accept: 'application/json, text/event-stream', 'mcp-protocol-version': version!, 'mcp-method': body?.includes('foo/bar') ? 'foo/bar' : 'tools/list' }, body })
        await response.text()
        const traces = server.getStatus().recentRequests
        expect(traces.length).toBe(before + 1)
        expect(traces.at(-1)?.rpcResultOk).not.toBe(true)
        expect(traces.at(-1)?.rpcErrorCode).toBeDefined()
        if (contentType === 'text/plain') { expect(response.status).toBe(415); expect(traces.at(-1)?.responseReason).toBe('content-type-not-supported') }
        if (body?.includes('foo/bar')) expect(traces.at(-1)?.rpcErrorCode).toBe(-32601)
        if (version === '2099-01-01') expect(traces.at(-1)?.responseReason).toBe('protocol-version-rejected')
      }
    })
  })

  it('Given legacy session When GET/DELETE/cross-profile Then SSE 可用且范围不可越过', async () => {
    await withMcpServer(async (server, endpoint) => {
      const client = new Client({ name: 'legacy', version: '1' })
      const transport = new StreamableHTTPClientTransport(new URL(endpoint))
      try {
        await client.connect(transport)
        expect((await client.listTools()).tools.length).toBeGreaterThan(0)
        const sessionId = transport.sessionId!
        expect(sessionId).toBeDefined()
        expect(server.getStatus().recentRequests.some((trace) => trace.sessionEvent === 'created')).toBe(true)
        const other = await fetch(endpoint + '/empty', { method: 'DELETE', headers: { 'mcp-session-id': sessionId } })
        expect(other.status).toBe(404)
        const abort = new AbortController()
        // SDK Client 关闭只发起 abort；等待服务端观测到 GET 断开再重新打开流。
        await client.close()
        for (let attempt = 0; attempt < 20 && !server.getStatus().recentRequests.some((t) => t.method === 'GET'); attempt++) await Bun.sleep(10)
        const stream = await fetch(endpoint, { headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId }, signal: abort.signal })
        expect(stream.status).toBe(200)
        expect(stream.headers.get('content-type')).toContain('text/event-stream')
        abort.abort()
        const deleted = await fetch(endpoint, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } })
        expect(deleted.status).toBe(200)
        expect(server.getStatus().activeSessions).toBe(0)
        expect(server.getStatus().recentRequests.some((trace) => trace.method === 'DELETE' && trace.sessionEvent === 'closed')).toBe(true)
        for (const method of ['GET', 'DELETE']) {
          const response = await fetch(endpoint, { method, headers: { 'mcp-protocol-version': MODERN_PROTOCOL_VERSION } })
          expect(response.status).toBe(405)
        }
      } finally { await client.close() }
    })
  })

  it('Given discover → initialize + 406 When 诊断 Then fallback 优先且保留 transport 警告', async () => {
    await withMcpServer(async (server, endpoint) => {
      await fetch(endpoint, { method: 'POST', headers: { 'x-openai-subject': 'synthetic-fixture', 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': MODERN_PROTOCOL_VERSION, 'mcp-method': 'server/discover' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: modernMeta } }) })
      const client = new Client({ name: 'fallback-fixture', version: '1' })
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { 'x-openai-subject': 'synthetic-fixture' } } }))
        await fetch(endpoint, { method: 'POST', headers: { 'x-openai-subject': 'synthetic-fixture', 'content-type': 'application/json', accept: 'image/png' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })
        const traces = server.getStatus().recentRequests
        const protocol = analyzeProtocol(traces, true)
        expect(protocol.protocolNegotiation?.era).toBe('mixed')
        expect(protocol.protocolNegotiation?.fallbackDetected).toBe(true)
        expect(protocol.transport?.http406Count).toBe(1)
        expect(classifyConnectorConclusion({ recentCount: traces.length, allRejected: false, discoverCount: 1, discoverOk: true, toolsListCount: 1, toolsListOk: false, doctorOk: true, protocol })?.id).toBe('B-ERA-FALLBACK')
      } finally { await client.close() }
    })
  })
})
