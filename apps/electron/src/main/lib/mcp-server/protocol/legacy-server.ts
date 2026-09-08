/** 旧 initialize/session/SSE 适配；与现代入口共用工具和权限。 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { SessionManager } from '../session-manager'
import { MCP_SERVER_INFO, validatedTools, type McpToolHandlers } from './modern-server'

export class LegacyMcpServer {
  readonly sessions = new SessionManager()

  constructor() {
    this.sessions.startIdleSweep((id) => { void this.closeSession(id) })
  }

  async closeSession(id: string): Promise<void> {
    const entry = this.sessions.get(id)
    if (!entry) return
    this.sessions.delete(id)
    await entry.server.close()
  }

  async close(): Promise<void> {
    this.sessions.stopIdleSweep()
    this.sessions.closeAll()
  }

  async handle(req: IncomingMessage, res: ServerResponse, body: unknown, profileId: string | undefined, handlers: McpToolHandlers): Promise<void> {
    const sessionId = req.headers['mcp-session-id']
    if (typeof sessionId === 'string') {
      const entry = this.sessions.get(sessionId)
      if (!entry || entry.profileId !== profileId) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } }))
        return
      }
      this.sessions.touch(sessionId)
      await entry.transport.handleRequest(req, res, body)
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: validatedTools(handlers) }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const result = await handlers.call(request.params.name, request.params.arguments ?? {})
      return { ...result, content: result.content ?? [] }
    })
    const initialize = Boolean(body && typeof body === 'object' && 'method' in body && body.method === 'initialize')
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: initialize ? () => randomUUID() : undefined,
      onsessioninitialized: (id): void => { this.sessions.set(id, { transport, server, createdAt: Date.now(), lastUsedAt: Date.now(), profileId }) },
      onsessionclosed: (id) => { this.sessions.delete(id) },
    })
    await server.connect(transport)
    try {
      await transport.handleRequest(req, res, body)
    } finally {
      if (!transport.sessionId || !this.sessions.get(transport.sessionId)) await server.close()
    }
  }
}
