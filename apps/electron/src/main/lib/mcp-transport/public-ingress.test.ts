import { it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { randomBytes } from 'node:crypto'
import { PublicMcpIngress } from './public-ingress'
import { createConfiguredTools } from '../mcp-server/configured-tools'
import { createDefaultLocalToolRegistry } from '../local-tools/registry'
import { normalizePromaMcpServerConfig } from '../mcp-server/config'
import { probePublicMcp } from './public-probe'

it('Given 内部 full workspace When 通过 Public Ingress Then 只读、Secret、Legacy 与路径边界均强制执行', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'proma-public-test-'))
  const rootPath = join(fixtureRoot, 'workspace')
  mkdirSync(rootPath)
  writeFileSync(join(fixtureRoot, 'outside.txt'), 'not authorized')
  writeFileSync(join(rootPath, 'README.md'), 'public fixture')
  let secret = randomBytes(32).toString('base64url')
  let enabled = true
  const entry = { id: 'ws_public', rootPath, name: 'fixture', enabled: true, permissions: { read: true, write: true, shell: true } }
  const tools = createConfiguredTools({ config: () => normalizePromaMcpServerConfig({ accessMode: 'full', tools: { fileRead: true, fileWrite: true, shell: true, search: true, git: true } }),
    entries: () => enabled ? [entry] : [], registry: createDefaultLocalToolRegistry(), resolve: () => ({ entry, context: { rootPath, workspaceId: entry.id } }) })
  const ingress = new PublicMcpIngress(tools, () => secret, 'probe-marker')
  const other = new PublicMcpIngress(tools, () => secret, 'probe-marker')
  const client = new Client({ name: 'public-fixture', version: '1' }, { versionNegotiation: { mode: 'auto' } })
  try {
    const local = await ingress.start(0)
    const endpoint = local + '/mcp/' + secret
    await expect(other.start(Number(new URL(local).port))).rejects.toThrow('PUBLIC_INGRESS_PORT_IN_USE')
    expect((await fetch(local + '/mcp/wrong')).status).toBe(404)
    expect((await fetch(endpoint, { method: 'GET' })).status).toBe(405)
    expect((await fetch(endpoint, { method: 'DELETE' })).status).toBe(405)
    const legacy = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } }) })
    expect(legacy.status).toBe(400)
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
    expect(client.getProtocolEra()).toBe('modern')
    const listed = await client.listTools()
    expect(listed.tools).toHaveLength(10)
    expect(listed.tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
    for (const name of ['write_file', 'edit_file', 'shell_execute']) {
      expect(listed.tools.some((t) => t.name === name)).toBe(false)
      expect((await client.callTool({ name, arguments: { path: 'forbidden.txt', content: 'x', command: 'echo BAD' } })).isError).toBe(true)
    }
    expect(existsSync(join(rootPath, 'forbidden.txt'))).toBe(false)
    expect((await client.callTool({ name: 'read_file', arguments: { path: 'README.md' } })).isError).toBe(false)
    expect((await client.callTool({ name: 'read_file', arguments: { path: '../outside.txt' } })).isError).toBe(true)
    enabled = false
    expect((await client.callTool({ name: 'read_file', arguments: { path: 'README.md' } })).isError).toBe(true)
    enabled = true
    expect((await probePublicMcp(endpoint, 'probe-marker')).toolCount).toBe(10)
    expect(ingress.getRequests().some((t) => t.probe)).toBe(true)
    expect(JSON.stringify(ingress.getRequests())).not.toContain(secret)
    secret = randomBytes(32).toString('base64url')
    expect((await fetch(endpoint)).status).toBe(404)
    secret = ''
    expect((await fetch(local + '/mcp/')).status).toBe(404)
  } finally { await client.close(); await ingress.stop(); await other.stop(); rmSync(fixtureRoot, { recursive: true, force: true }) }
})
