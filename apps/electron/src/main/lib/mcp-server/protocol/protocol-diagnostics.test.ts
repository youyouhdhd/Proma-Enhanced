import { describe, expect, it, setSystemTime } from 'bun:test'
import type { PromaMcpRequestTrace } from '@proma/shared'
import { analyzeProtocol } from './protocol-negotiation'
import { computeMethodStats } from './request-trace'
import { withMcpServer } from './test-fixture'
import { formatProtocolExport } from '../../../../renderer/components/settings/mcp-protocol-export'

describe('V8 诊断证据与安全边界', () => {
  it('Given HTTP 200 RPC error When tools/list 分析 Then 不显示绿色', () => {
    const trace: PromaMcpRequestTrace = { at: 1, method: 'POST', path: '/mcp', hasSessionId: false, statusCode: 200, completed: true, jsonRpcMethod: 'tools/list', rpcErrorCode: -32601 }
    expect(analyzeProtocol([trace], true).toolDiscovery?.ok).toBe(false)
    expect(analyzeProtocol([trace], true).connectorReady).toBe(false)
    expect(computeMethodStats([{ ...trace, jsonRpcMethod: '__proto__' }]).methods.__proto__).toBe(1)
  })

  it('Given 调试窗口 When 两分钟到期 Then 自动停止 metadata 采集', async () => {
    await withMcpServer(async (server, endpoint) => {
      const start = server.getStatus().protocolDebug!.startedAt
      try {
        setSystemTime(start + 120_001)
        expect(server.getStatus().protocolDebug?.active).toBe(false)
        await fetch(endpoint, { headers: { accept: 'text/event-stream' } })
        expect(server.getStatus().recentRequests.at(-1)?.requestMetadata).toBeUndefined()
      } finally { setSystemTime() }
    })
  })

  it('Given 多余敏感状态字段 When 导出 Then 只包含允许字段', () => {
    const injected = {
      appVersion: '1.7.0', authorization: 'secret-auth',
      recentRequests: [{ at: 1, method: 'POST', path: '/mcp', hasSessionId: false, statusCode: 406,
        arguments: { content: 'secret-content' }, requestMetadata: { accept: 'image/png', authorization: 'secret-header' } }],
    }
    const text = formatProtocolExport(injected as unknown as Parameters<typeof formatProtocolExport>[0], null, null)
    expect(text).toContain('image/png')
    expect(text).not.toContain('secret-')
  })
})
