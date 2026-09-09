import { createServer, type IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { McpTransportStatus } from '@proma/shared'
import { createModernServer, type McpToolHandlers } from '../mcp-server/protocol/modern-server'
import { readRequestBody, isMcpJsonRpc } from '../mcp-server/protocol/request-classifier'
import { usesLegacyProtocol } from '../mcp-server/protocol/protocol-router'
import { PUBLIC_READONLY_TOOLS } from '../mcp-server/configured-tools'
export { PUBLIC_READONLY_TOOLS } from '../mcp-server/configured-tools'

export class PublicMcpIngress {
  private server: ReturnType<typeof createServer> | undefined
  private engine: ReturnType<typeof createModernServer> | undefined
  private origin?: string
  private closing?: Promise<void>
  private readonly traces: NonNullable<McpTransportStatus['requests']> = []
  constructor(private readonly tools: McpToolHandlers, private readonly secret: () => string, private readonly probeMarker: string) {}
  setPublicOrigin(origin?: string): void { this.origin = origin }
  getRequests(): NonNullable<McpTransportStatus['requests']> { return this.traces.map((t) => ({ ...t })) }
  private validHost(req: IncomingMessage): boolean {
    try {
      const host = new URL('http://' + req.headers.host)
      const allowed = ['127.0.0.1', 'localhost', ...(this.origin ? [new URL(this.origin).hostname] : [])]
      if (host.username || host.password || host.pathname !== '/' || host.search || host.hash || !allowed.includes(host.hostname)) return false
      const origin = req.headers.origin
      return !origin || origin === this.origin || origin === 'http://' + req.headers.host && ['127.0.0.1', 'localhost'].includes(host.hostname)
    } catch { return false }
  }
  async start(port: number): Promise<string> {
    await this.closing
    if (this.server) throw new Error('PUBLIC_INGRESS_ALREADY_RUNNING')
    const secret = this.secret()
    if (!/^[A-Za-z0-9_-]{43,}$/.test(secret)) throw new Error('PUBLIC_CONNECTOR_SECRET_MISSING')
    this.traces.length = 0
    this.engine = createModernServer({
      list: () => this.tools.list().filter((t) => PUBLIC_READONLY_TOOLS.has(t.name) && t.annotations.readOnlyHint),
      call: (name, args) => PUBLIC_READONLY_TOOLS.has(name) && this.tools.list().some((t) => t.name === name && t.annotations.readOnlyHint)
        ? this.tools.call(name, args) : Promise.resolve({ content: [{ type: 'text', text: 'Public ingress is read-only' }], isError: true }),
    })
    const server = createServer((req, res) => {
      const trace: NonNullable<McpTransportStatus['requests']>[number] = { at: Date.now(), method: req.method ?? '', status: 0, path: '/mcp/<redacted>', probe: req.headers['x-proma-probe'] === this.probeMarker }
      let recorded = false
      const finish = () => { if (!recorded) { recorded = true; trace.status = res.statusCode; this.traces.push(trace); if (this.traces.length > 100) this.traces.shift() } }
      res.once('finish', finish); res.once('close', finish)
      void (async () => {
        if (!this.validHost(req)) { res.writeHead(403).end(); return }
        const currentSecret = this.secret()
        if (!/^[A-Za-z0-9_-]{43,}$/.test(currentSecret)) { res.writeHead(404).end(); return }
        const expected = Buffer.from('/mcp/' + currentSecret)
        const actual = Buffer.from(req.url ?? '')
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) { res.writeHead(404).end(); return }
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
        if (req.headers['mcp-session-id'] !== undefined) { res.writeHead(400).end('Modern stateless MCP required'); return }
        const body = await readRequestBody(req)
        if (body.kind !== 'json' || !isMcpJsonRpc(body.value) || await usesLegacyProtocol(req, body.value)) {
          res.writeHead(body.kind === 'too-large' ? 413 : 400).end('Modern MCP request required'); return
        }
        // 固定方法名白名单，恶意 RPC method 也不能把 secret 放进 trace。
        trace.rpcMethod = ['server/discover', 'tools/list', 'tools/call', 'ping'].includes(body.value.method) ? body.value.method : 'other'
        await this.engine!.handle(req, res, body.value)
      })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end('MCP request failed') })
    })
    this.server = server
    try {
      await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done) })
      const address = server.address() as { port: number }
      return 'http://127.0.0.1:' + address.port
    } catch (error) {
      await this.stop()
      throw new Error(error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE' ? 'PUBLIC_INGRESS_PORT_IN_USE' : 'PUBLIC_INGRESS_START_FAILED')
    }
  }
  async stop(): Promise<void> {
    if (this.closing) return this.closing
    const server = this.server; this.server = undefined
    const engine = this.engine; this.engine = undefined
    this.closing = (async () => {
      if (server) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())) }
      await engine?.close().catch(() => undefined)
    })()
    try { await this.closing } finally { this.closing = undefined }
  }
}
