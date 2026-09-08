import { describe, expect, it } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { isSpecType } from '@modelcontextprotocol/server'
import { MODERN_PROTOCOL_VERSION as LATEST_PROTOCOL_VERSION } from './modern-server'
import { analyzeProtocol } from './protocol-negotiation'
import { withMcpServer } from './test-fixture'

describe('V8 官方 Client 协议协商', () => {
  for (const mode of ['auto', { pin: LATEST_PROTOCOL_VERSION }] as const) {
    it('Given 官方 Client When connect/list/call Then modern 且无 initialize：' + JSON.stringify(mode), async () => {
      await withMcpServer(async (server, endpoint) => {
        const client = new Client({ name: 'official-v8', version: '1' }, { versionNegotiation: { mode } })
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
          expect(client.getProtocolEra()).toBe('modern')
          const list = await client.listTools()
          expect(isSpecType.ListToolsResult(list)).toBe(true)
          for (const name of ['workspace_list', 'workspace_info', 'read_file', 'read_many', 'git_status', 'git_diff', 'git_status_batch', 'search_text', 'find_files', 'list_files', 'write_file', 'edit_file', 'shell_execute']) {
            expect(list.tools.some((t) => t.name === name && isSpecType.Tool(t))).toBe(true)
          }
          for (const [name, args] of [
            ['workspace_list', {}], ['git_status', { workspace_id: 'ws_test' }], ['read_file', { workspace_id: 'ws_test', path: 'hello.txt' }],
          ] as const) {
            const result = await client.callTool({ name, arguments: args })
            expect(result.isError, name + ': ' + JSON.stringify(result)).toBe(false)
          }
          const denied = await client.callTool({ name: 'read_file', arguments: { path: '../secret' } })
          expect(denied.isError).toBe(true)
          const traces = server.getStatus().recentRequests
          expect(traces.some((t) => t.jsonRpcMethod === 'initialize')).toBe(false)
          expect(traces.some((t) => t.statusCode === 406)).toBe(false)
          expect(traces.some((t) => t.discoverValidated)).toBe(true)
          expect(analyzeProtocol(traces, true).connectorReady).toBe(true)
          expect(JSON.stringify(traces)).not.toContain('fixture content')
          expect(JSON.stringify(traces)).not.toContain('../secret')
        } finally { await client.close() }
      })
    })
  }

  it('Given managed bearer When 正确/错误/缺失密钥 Then 认证与 trace 一致', async () => {
    for (const stored of ['secret-test', undefined]) {
      await withMcpServer(async (server, endpoint) => {
        const client = new Client({ name: 'auth-test', version: '1' }, { versionNegotiation: { mode: 'auto' } })
        try {
          const connecting = client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { authorization: 'Bearer secret-test' } } }))
          if (stored) { await connecting; expect(client.getProtocolEra()).toBe('modern') }
          else await expect(connecting).rejects.toThrow()
          const denied = await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer wrong-secret', 'content-type': 'application/json' }, body: '{}' })
          expect(denied.status).toBe(401)
          expect(server.getStatus().recentRequests.at(-1)?.authResult).toBe('rejected')
          expect(JSON.stringify(server.getStatus().recentRequests)).not.toContain('secret-test')
          expect(JSON.stringify(server.getStatus().recentRequests)).not.toContain('wrong-secret')
        } finally { await client.close() }
      }, { auth: { type: 'managed-bearer' } }, stored)
    }
  })

  it('Given profile/read-only When 隐藏工具或范围外 workspace 调用 Then 拒绝', async () => {
    await withMcpServer(async (_server, endpoint) => {
      for (const suffix of ['', '/empty']) {
        const client = new Client({ name: 'permissions', version: '1' }, { versionNegotiation: { mode: 'auto' } })
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(endpoint + suffix)))
          const denied = await client.callTool({ name: suffix ? 'read_file' : 'write_file', arguments: { workspace_id: 'ws_test', path: 'hello.txt', content: 'forbidden' } })
          expect(denied.isError).toBe(true)
        } finally { await client.close() }
      }
    }, { accessMode: 'read-only' })
  })
})
