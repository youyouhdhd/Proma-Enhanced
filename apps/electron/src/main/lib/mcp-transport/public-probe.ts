import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { McpTransportStatus } from '@proma/shared'
import { isSpecType } from '@modelcontextprotocol/server'

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
    if (!isSpecType.ListToolsResult(list) || !list.tools.length) throw new Error()
    const workspaceList = list.tools.some((t) => t.name === 'workspace_list')
    if (workspaceList && (await client.callTool({ name: 'workspace_list', arguments: {} })).isError) throw new Error()
    const discover = client.getDiscoverResult()
    const instructions = typeof discover?.instructions === 'string' && discover.instructions.trim().length > 0
    return { modern: true, toolCount: list.tools.length, workspaceList, instructions }
  } catch { throw new Error(stage) } finally { await client.close().catch(() => undefined) }
}
