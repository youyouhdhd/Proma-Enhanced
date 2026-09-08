/** HTTP 意图先于 MCP era；来源仅为可观察证据，不作为认证依据。 */
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { PromaMcpRequestKind, PromaMcpRequestSource, PromaMcpSourceSignals } from '@proma/shared'

export type ParsedHttpBody = { kind: 'empty' } | { kind: 'json'; value: unknown } | { kind: 'invalid-json' } | { kind: 'too-large' }

export interface RequestClassification {
  kind: PromaMcpRequestKind
  source: PromaMcpRequestSource
  signals: PromaMcpSourceSignals
}

export function isMcpJsonRpc(value: unknown): value is { jsonrpc: '2.0'; method: string } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && 'jsonrpc' in value && value.jsonrpc === '2.0' && 'method' in value && typeof value.method === 'string')
}

/** 保留 v1 transport 的旧 batch 能力；现代协议是否接受仍由官方 handler 决定。 */
function isMcpRpcBody(value: unknown): boolean {
  return isMcpJsonRpc(value) || Array.isArray(value) && value.length > 0 && value.every(isMcpJsonRpc)
}

export function classifyRequest(input: { method: string; path: string; headers: IncomingHttpHeaders; parsedBody?: ParsedHttpBody; hasMcpSessionId: boolean }): RequestClassification {
  const signals: PromaMcpSourceSignals = {
    hasOpenAiSubject: input.headers['x-openai-subject'] !== undefined,
    hasOpenAiSession: input.headers['x-openai-session'] !== undefined,
    tunnelClientUserAgent: /^(?:oai-tunnel-client|openai-tunnel-client|tunnel-client)(?:[/\s]|$)/i.test(String(input.headers['user-agent'] ?? '')),
  }
  let kind: PromaMcpRequestKind = 'unknown-http'
  if (input.path === '/health') kind = 'health'
  else if (/^\/\.well-known\/oauth-protected-resource(?:\/mcp(?:\/[^/]+)?)?\/?$/.test(input.path)) kind = 'oauth-well-known'
  else if (/^\/mcp(?:\/[^/]+)?\/?$/.test(input.path)) {
    if (input.method === 'POST' && input.parsedBody?.kind === 'json' && isMcpRpcBody(input.parsedBody.value)) kind = 'mcp-rpc'
    else if (['GET', 'DELETE'].includes(input.method) && input.hasMcpSessionId) kind = 'legacy-session-stream'
    else if (!input.hasMcpSessionId && (input.method === 'GET' || input.method === 'POST' && input.parsedBody?.kind === 'empty')) kind = 'oauth-probe'
  }
  // 缺少 marker 的 tunnel RPC 不能证明来自本地 Client，保留 unknown 供排查转发头丢失。
  const source: PromaMcpRequestSource = signals.hasOpenAiSubject || signals.hasOpenAiSession ? 'connector-forwarded'
    : signals.tunnelClientUserAgent ? (kind === 'mcp-rpc' ? 'unknown' : 'tunnel-client-internal')
      : kind === 'mcp-rpc' ? 'local-mcp-client' : 'unknown'
  return { kind, source, signals }
}

export async function readRequestBody(req: IncomingMessage): Promise<ParsedHttpBody> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > 1024 * 1024) return { kind: 'too-large' }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return { kind: 'empty' }
  try { return { kind: 'json', value: JSON.parse(raw) } } catch { return { kind: 'invalid-json' } }
}
