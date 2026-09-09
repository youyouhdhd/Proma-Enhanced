import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { McpTransportStatus } from '@proma/shared'
import { PUBLIC_READONLY_TOOLS } from './public-ingress'

export async function probePublicMcp(endpoint: string, marker: string, signal?: AbortSignal): Promise<NonNullable<McpTransportStatus['probe']>> {
  const client = new Client({ name: 'proma-public-probe', version: '1' }, { versionNegotiation: { mode: 'auto' } })
  let stage = 'PUBLIC_MCP_UNREACHABLE'
  try {
    const timeout = AbortSignal.timeout(12_000)
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: {
      headers: { 'x-proma-probe': marker }, signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    } }))
    stage = 'PUBLIC_MCP_NEGOTIATION_FAILED'
    if (client.getProtocolEra() !== 'modern') throw new Error()
    stage = 'PUBLIC_MCP_TOOL_DISCOVERY_FAILED'
    const list = await client.listTools()
    if (list.tools.length !== PUBLIC_READONLY_TOOLS.size || list.tools.some((t) => !PUBLIC_READONLY_TOOLS.has(t.name) || !t.annotations?.readOnlyHint)) throw new Error()
    if ((await client.callTool({ name: 'workspace_list', arguments: {} })).isError) throw new Error()
    return { modern: true, toolCount: list.tools.length, workspaceList: true }
  } catch { throw new Error(stage) } finally { await client.close().catch(() => undefined) }
}
