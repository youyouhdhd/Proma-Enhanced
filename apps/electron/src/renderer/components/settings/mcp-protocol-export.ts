import type { PromaMcpConnectorDiagnosis, PromaMcpRequestTrace, PromaMcpServerStatus, PromaMcpTunnelState } from '@proma/shared'

/** 显式允许列表；不得 stringify 整个 IPC 状态、Doctor 输出或配置。 */
export function formatProtocolTrace(t: PromaMcpRequestTrace): string {
  const h = t.requestMetadata
  return [
    new Date(t.at).toISOString() + ' ' + t.method + ' ' + t.path,
    'RPC: ' + (t.jsonRpcMethod ?? 'unknown') + ' · HTTP ' + t.statusCode + ' · session=' + t.hasSessionId + ' · transition=' + (t.sessionEvent ?? '-'),
    'Accept: ' + (h?.accept ?? '未采集') + ' · Content-Type: ' + (h?.contentType ?? '未采集'),
    'MCP Protocol: ' + (h?.protocolVersionHeader ?? t.protocolVersion ?? 'unknown'),
    'Mcp-Method: ' + (h?.mcpMethod ?? '-') + ' · Mcp-Name: ' + (h?.mcpName ?? '-'),
    'Reason: ' + (t.responseReason ?? '-') + ' · RPC error: ' + (t.rpcErrorCode ?? '-') + ' · era=' + (t.protocolEra ?? 'unknown'),
  ].join('\n')
}

export function formatProtocolExport(status: PromaMcpServerStatus | null, tunnel: PromaMcpTunnelState | null, diagnosis: PromaMcpConnectorDiagnosis | null): string {
  const traces = diagnosis?.traces ?? status?.recentRequests ?? []
  return [
    'PROMA ' + (status?.appVersion ?? 'unknown'),
    'MCP Protocol ' + (status?.mcpProtocolVersion ?? 'unknown'),
    'Tunnel Client ' + (tunnel?.client?.version ?? 'unknown'),
    'Doctor: ' + (diagnosis?.checks.find((c) => c.name === 'Doctor 诊断')?.state ?? '未检查'),
    'readyz: ' + (diagnosis?.checks.find((c) => c.name === 'Secure Tunnel /readyz')?.state ?? '未检查'),
    'Protocol Era: ' + (diagnosis?.protocolNegotiation?.era ?? 'unknown'),
    'Fallback: ' + (diagnosis?.protocolNegotiation?.fallbackDetected ?? false),
    'Method histogram: ' + JSON.stringify(diagnosis?.stats?.methods ?? {}),
    'HTTP histogram: ' + JSON.stringify(diagnosis?.stats?.statuses ?? {}),
    ...traces.map(formatProtocolTrace),
  ].join('\n\n')
}
