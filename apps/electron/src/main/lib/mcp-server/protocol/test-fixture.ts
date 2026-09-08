import { MODERN_PROTOCOL_VERSION as LATEST_PROTOCOL_VERSION } from './modern-server'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { PromaMcpServer } from '../server'
import { createDefaultLocalToolRegistry } from '../../local-tools/registry'
import type { PromaMcpServerConfig } from '@proma/shared'

export const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'proma-wire-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

export async function withMcpServer(run: (server: PromaMcpServer, endpoint: string) => Promise<void>, overrides: Partial<PromaMcpServerConfig> = {}, token?: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proma-v8-'))
  const server = new PromaMcpServer()
  try {
    writeFileSync(join(root, 'hello.txt'), 'fixture content must not appear in trace')
    execFileSync('git', ['init', '--quiet', root])
    const permissions = { read: true, write: true, shell: true }
    const entry = { id: 'ws_test', name: '测试', rootPath: root, enabled: true, permissions }
    const status = await server.start({
      config: { enabled: true, host: '127.0.0.1', port: 'auto', workspaces: [], profiles: [{ id: 'empty', name: '空范围', workspaceIds: [], enabled: true }], accessMode: 'full',
        tools: { fileRead: true, fileWrite: true, search: true, git: true, shell: true }, auth: { type: 'none' }, ...overrides },
      listWorkspaces: () => [entry],
      resolveWorkspaceContext: () => ({ entry, context: { rootPath: root, workspaceId: entry.id } }),
      registry: createDefaultLocalToolRegistry(),
      resolveAuthToken: () => token,
    })
    server.startProtocolDebug()
    await run(server, status.endpoint)
  } finally {
    await server.stop()
    rmSync(root, { recursive: true, force: true })
  }
}
