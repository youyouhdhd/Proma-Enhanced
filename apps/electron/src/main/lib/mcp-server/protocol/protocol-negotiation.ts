/** 只将完成且经过官方 schema 验证的 RPC 结果视为协议证据。 */
import type { PromaMcpConnectorDiagnosis, PromaMcpRequestTrace, PromaMcpProtocolNegotiation, ToolDiscoveryState } from '@proma/shared'

export function rpcSucceeded(trace: PromaMcpRequestTrace): boolean {
  return trace.completed === true && trace.statusCode >= 200 && trace.statusCode < 300 && trace.rpcErrorCode === undefined && trace.rpcResultOk === true
}

export function analyzeProtocol(traces: PromaMcpRequestTrace[], tunnelReady: boolean): Pick<PromaMcpConnectorDiagnosis, 'protocolNegotiation' | 'transport' | 'toolDiscovery' | 'connectorReady' | 'toolCallOk'> {
  const discover = traces.filter((t) => t.jsonRpcMethod === 'server/discover')
  const initialize = traces.filter((t) => t.jsonRpcMethod === 'initialize')
  const lists = traces.filter((t) => t.jsonRpcMethod === 'tools/list')
  const validList = lists.findLast((t) => rpcSucceeded(t) && t.schemaValidated)
  const modernList = lists.some((t) => rpcSucceeded(t) && t.schemaValidated && t.protocolEra === 'modern')
  const discoverRpcOk = discover.some((t) => rpcSucceeded(t) && t.discoverValidated)
  const fallbackDetected = discover.some((d) => rpcSucceeded(d) && initialize.some((i) => i.at >= d.at && i.path === d.path))
  const protocolNegotiation: PromaMcpProtocolNegotiation = {
    era: discover.length && initialize.length ? 'mixed' : initialize.length ? 'legacy' : discoverRpcOk && modernList ? 'modern' : 'unknown',
    discoverSeen: discover.length > 0,
    discoverHttpOk: discover.some((t) => t.completed && t.statusCode >= 200 && t.statusCode < 300),
    discoverRpcOk,
    initializeSeen: initialize.length > 0,
    initializedNotificationSeen: traces.some((t) => t.jsonRpcMethod === 'notifications/initialized'),
    toolsListSeen: lists.length > 0,
    fallbackDetected,
  }
  const toolDiscovery: ToolDiscoveryState = {
    requested: lists.length > 0,
    httpOk: lists.some((t) => t.completed && t.statusCode >= 200 && t.statusCode < 300),
    rpcOk: lists.some(rpcSucceeded),
    ok: Boolean(validList),
    ...(validList ? { toolCount: validList.toolCount, schemaValidated: true } : {}),
  }
  const rejectedRequests = traces.filter((t) => t.statusCode === 406 || t.statusCode === 415 || t.responseReason === 'protocol-version-rejected')
  return {
    protocolNegotiation,
    transport: { http406Count: traces.filter((t) => t.method === 'POST' && t.statusCode === 406).length, rejectedRequests },
    toolDiscovery,
    toolCallOk: traces.some((t) => t.jsonRpcMethod === 'tools/call' && rpcSucceeded(t) && t.toolCallOk === true),
    connectorReady: tunnelReady && protocolNegotiation.era === 'modern' && toolDiscovery.ok && rejectedRequests.length === 0,
  }
}
