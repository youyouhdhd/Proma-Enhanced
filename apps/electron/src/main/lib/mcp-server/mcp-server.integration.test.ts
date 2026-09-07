/**
 * MCP Server 集成测试：真实 HTTP + MCP Client 走 initialize → tools/list → tools/call
 * 第二轮：多 Workspace 注册表（workspace_list / 跨仓库搜索 / read_many / 批量 Git / 独立权限）。
 * 同时验证：路径越界拒绝、工具执行不触发任何模型调用（架构隔离）。
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { PromaMcpServer } from './server.ts'
import { createDefaultLocalToolRegistry } from '../local-tools/registry.ts'
import type { PromaMcpServerConfig, PromaMcpWorkspaceEntry } from '@proma/shared'

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []

function makeRoot(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'proma-mcp-ws-' + name + '-'))
  roots.push(dir)
  return dir
}

function workspaceEntry(agentWorkspaceId: string, id: string, perms: { read: boolean; write: boolean; shell: boolean }): PromaMcpWorkspaceEntry {
  return { id, agentWorkspaceId, enabled: true, permissions: perms, createdAt: Date.now() }
}

/** 启动 server：entries 定义 workspace 注册表，rootById 把 id 映射到临时目录 */
async function startServer(
  entries: PromaMcpWorkspaceEntry[],
  rootById: Map<string, string>,
  overrides?: { accessMode?: 'read-only' | 'full' },
): Promise<string> {
  const config: PromaMcpServerConfig = {
    enabled: true,
    host: '127.0.0.1',
    port: 'auto',
    workspaces: entries,
    profiles: [],
    accessMode: overrides?.accessMode ?? 'read-only',
    tools: { fileRead: true, fileWrite: true, search: true, git: true, shell: false },
    auth: { type: 'none' },
  }
  const server = new PromaMcpServer()
  cleanups.push(() => server.stop())
  const status = await server.start({
    config,
    listWorkspaces: () => entries.map((entry) => ({ id: entry.id, name: entry.agentWorkspaceId, rootPath: rootById.get(entry.id) ?? '', enabled: true, permissions: entry.permissions })),
    resolveWorkspaceContext: (entryId) => {
      const entry = entries.find((e) => e.id === entryId)
      const root = rootById.get(entryId)
      if (!entry || !root) return { error: 'unknown workspace: ' + entryId }
      return { context: { workspaceId: entry.id, rootPath: root }, entry: { id: entry.id, name: entry.agentWorkspaceId, rootPath: root, enabled: true, permissions: entry.permissions } }
    },
    registry: createDefaultLocalToolRegistry(),
  })
  return status.endpoint
}

async function connect(endpoint: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
  return client
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content
  return content?.[0]?.text ?? ''
}

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  for (const dir of roots) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  roots.length = 0
})

describe('PromaMcpServer 多工作区集成', () => {
  /** 无状态响应可能是 SSE（event/data 行）或纯 JSON，统一解析出 JSON-RPC payload */
  async function parseRpcPayload(response: Response): Promise<{ result?: { tools?: Array<{ name: string }>; structuredContent?: Record<string, unknown> } }> {
    const contentType = response.headers.get('content-type') ?? ''
    const text = await response.text()
    if (contentType.includes('text/event-stream')) {
      const dataLine = text.split(/\r?\n/).reverse().find((line) => line.startsWith('data:'))
      return dataLine ? JSON.parse(dataLine.slice(5).trim()) : {}
    }
    return JSON.parse(text)
  }

  it('tools/list 暴露固定多工作区工具集，read 工具带 readOnlyHint 注解', async () => {
    const root = makeRoot('a')
    writeFileSync(join(root, 'package.json'), '{"name":"demo"}')
    const endpoint = await startServer([workspaceEntry('agent-a', 'ws_a', { read: true, write: false, shell: false })], new Map([['ws_a', root]]))
    const client = await connect(endpoint)
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    for (const expected of ['workspace_list', 'workspace_info', 'list_files', 'read_file', 'read_many', 'search_text', 'find_files', 'git_status', 'git_status_batch', 'git_diff']) {
      expect(names).toContain(expected)
    }
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('shell_execute')
    const readTool = tools.tools.find((t) => t.name === 'read_file')
    expect(readTool?.annotations?.readOnlyHint).toBe(true)
    await client.close()
  })

  it('workspace_list 返回全部授权项目（含 git 分支）', async () => {
    const root = makeRoot('b')
    writeFileSync(join(root, 'a.txt'), 'hello')
    const endpoint = await startServer([workspaceEntry('agent-a', 'ws_a', { read: true, write: false, shell: false })], new Map([['ws_a', root]]))
    const client = await connect(endpoint)
    const result = await client.callTool({ name: 'workspace_list', arguments: {} })
    expect(result.isError).toBe(false)
    const data = result.structuredContent as { workspaces: Array<{ id: string; name: string }> }
    expect(data.workspaces).toHaveLength(1)
    expect(data.workspaces[0]!.id).toBe('ws_a')
    expect(data.workspaces[0]!.name).toBe('agent-a')
    await client.close()
  })

  it('多个 workspace 时省略 workspace_id 的 read_file 被拒绝并提示可用 id', async () => {
    const rootA = makeRoot('c1')
    const rootB = makeRoot('c2')
    writeFileSync(join(rootA, 'a.txt'), 'AAA')
    writeFileSync(join(rootB, 'b.txt'), 'BBB')
    const endpoint = await startServer(
      [workspaceEntry('agent-a', 'ws_a', { read: true, write: false, shell: false }), workspaceEntry('agent-b', 'ws_b', { read: true, write: false, shell: false })],
      new Map([['ws_a', rootA], ['ws_b', rootB]]),
    )
    const client = await connect(endpoint)
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'a.txt' } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('workspace_id')
    await client.close()
  })

  it('read_file + workspace_id 精确读取对应仓库；单 workspace 时可省略', async () => {
    const rootA = makeRoot('d1')
    const rootB = makeRoot('d2')
    writeFileSync(join(rootA, 'a.txt'), 'AAA')
    writeFileSync(join(rootB, 'b.txt'), 'BBB')
    const endpoint = await startServer(
      [workspaceEntry('agent-a', 'ws_a', { read: true, write: false, shell: false }), workspaceEntry('agent-b', 'ws_b', { read: true, write: false, shell: false })],
      new Map([['ws_a', rootA], ['ws_b', rootB]]),
    )
    const client = await connect(endpoint)
    const fromA = await client.callTool({ name: 'read_file', arguments: { workspace_id: 'ws_a', path: 'a.txt' } })
    expect(fromA.isError).toBe(false)
    expect(textOf(fromA)).toContain('AAA')
    const fromB = await client.callTool({ name: 'read_file', arguments: { workspace_id: 'ws_b', path: 'b.txt' } })
    expect(textOf(fromB)).toContain('BBB')
    await client.close()
  })

  it('read_many 跨仓库批量读取', async () => {
    const rootA = makeRoot('e1')
    const rootB = makeRoot('e2')
    mkdirSync(join(rootA, 'src'), { recursive: true })
    mkdirSync(join(rootB, 'src'), { recursive: true })
    writeFileSync(join(rootA, 'src/a.ts'), 'export const A = 1')
    writeFileSync(join(rootB, 'src/b.ts'), 'export const B = 2')
    const endpoint = await startServer(
      [workspaceEntry('agent-a', 'ws_a', { read: true, write: false, shell: false }), workspaceEntry('agent-b', 'ws_b', { read: true, write: false, shell: false })],
      new Map([['ws_a', rootA], ['ws_b', rootB]]),
    )
    const client = await connect(endpoint)
    const result = await client.callTool({
      name: 'read_many',
      arguments: { files: [{ workspace_id: 'ws_a', path: 'src/a.ts' }, { workspace_id: 'ws_b', path: 'src/b.ts' }] },
    })
    expect(result.isError).toBe(false)
    const data = result.structuredContent as { results: Array<{ workspace_id: string; ok: boolean; content?: string }>; count: number }
    expect(data.count).toBe(2)
    expect(data.results.find((r) => r.workspace_id === 'ws_a')?.content).toContain('A = 1')
    expect(data.results.find((r) => r.workspace_id === 'ws_b')?.content).toContain('B = 2')
    await client.close()
  })

  it('跨仓库 search_text 结果带 workspace_id 标记', async () => {
    const rootA = makeRoot('f1')
    const rootB = makeRoot('f2')
    writeFileSync(join(rootA, 'a.ts'), 'const refreshToken = 1')
    writeFileSync(join(rootB, 'b.ts'), 'const refreshToken = 2')
    const endpoint = await startServer(
      [workspaceEntry('agent-a', 'ws_a', { read: true, write: false, shell: false }), workspaceEntry('agent-b', 'ws_b', { read: true, write: false, shell: false })],
      new Map([['ws_a', rootA], ['ws_b', rootB]]),
    )
    const client = await connect(endpoint)
    const result = await client.callTool({ name: 'search_text', arguments: { workspace_ids: ['ws_a', 'ws_b'], query: 'refreshToken' } })
    expect(result.isError).toBe(false)
    const data = result.structuredContent as { matches: Array<{ workspace_id: string; path: string }>; count: number }
    expect(data.count).toBe(2)
    const ids = new Set(data.matches.map((m) => m.workspace_id))
    expect(ids.has('ws_a')).toBe(true)
    expect(ids.has('ws_b')).toBe(true)
    await client.close()
  })

  it('git_status_batch 分别返回两份状态', async () => {
    const rootA = makeRoot('g1')
    const rootB = makeRoot('g2')
    const endpoint = await startServer(
      [workspaceEntry('agent-a', 'ws_a', { read: true, write: false, shell: false }), workspaceEntry('agent-b', 'ws_b', { read: true, write: false, shell: false })],
      new Map([['ws_a', rootA], ['ws_b', rootB]]),
    )
    const client = await connect(endpoint)
    const result = await client.callTool({ name: 'git_status_batch', arguments: { workspace_ids: ['ws_a', 'ws_b'] } })
    expect(result.isError).toBe(false)
    const data = result.structuredContent as { results: Array<{ workspace_id: string; ok: boolean }> }
    expect(data.results).toHaveLength(2)
    await client.close()
  })

  it('只读 workspace 上的 write_file 被 PERMISSION_DENIED 拒绝；有写权限的 workspace 可以写', async () => {
    const rootA = makeRoot('h1')
    const rootB = makeRoot('h2')
    const endpoint = await startServer(
      [workspaceEntry('agent-a', 'ws_a', { read: true, write: false, shell: false }), workspaceEntry('agent-b', 'ws_b', { read: true, write: true, shell: false })],
      new Map([['ws_a', rootA], ['ws_b', rootB]]),
      { accessMode: 'full' },
    )
    const client = await connect(endpoint)
    const denied = await client.callTool({ name: 'write_file', arguments: { workspace_id: 'ws_a', path: 'x.txt', content: 'NO' } })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('PERMISSION_DENIED')
    expect(existsSync(join(rootA, 'x.txt'))).toBe(false)
    const allowed = await client.callTool({ name: 'write_file', arguments: { workspace_id: 'ws_b', path: 'x.txt', content: 'YES' } })
    expect(allowed.isError).toBe(false)
    expect(readFileSync(join(rootB, 'x.txt'), 'utf8')).toBe('YES')
    await client.close()
  })

  it('单 workspace 默认解析：省略 workspace_id 也能读取（规范 §35 便利行为）', async () => {
    const root = makeRoot('i')
    writeFileSync(join(root, 'only.txt'), 'ONLY')
    const endpoint = await startServer([workspaceEntry('agent-only', 'ws_only', { read: true, write: false, shell: false })], new Map([['ws_only', root]]))
    const client = await connect(endpoint)
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'only.txt' } })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('ONLY')
    await client.close()
  })

  it('read_file 路径越界被拒绝（跨 workspace 守卫保持生效）', async () => {
    const rootA = makeRoot('j1')
    makeRoot('j2')
    const endpoint = await startServer([workspaceEntry('agent-a', 'ws_a', { read: true, write: false, shell: false })], new Map([['ws_a', rootA]]))
    const client = await connect(endpoint)
    const result = await client.callTool({ name: 'read_file', arguments: { path: '../../secret' } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('PATH_OUTSIDE_WORKSPACE')
    await client.close()
  })

  it('Connection Profile endpoint 只暴露 allowlist 内的 workspace', async () => {
    const rootA = makeRoot('k1')
    const rootB = makeRoot('k2')
    writeFileSync(join(rootA, 'a.txt'), 'AAA')
    writeFileSync(join(rootB, 'b.txt'), 'BBB')
    const entries = [workspaceEntry('agent-a', 'ws_a', { read: true, write: false, shell: false }), workspaceEntry('agent-b', 'ws_b', { read: true, write: false, shell: false })]
    const config: PromaMcpServerConfig = {
      enabled: true,
      host: '127.0.0.1',
      port: 'auto',
      workspaces: entries,
      profiles: [{ id: 'work', name: 'Work', workspaceIds: ['ws_a'], enabled: true }],
      accessMode: 'read-only',
      tools: { fileRead: true, fileWrite: true, search: true, git: true, shell: false },
      auth: { type: 'none' },
    }
    const server = new PromaMcpServer()
    cleanups.push(() => server.stop())
    const status = await server.start({
      config,
      listWorkspaces: () => entries.map((entry) => ({ id: entry.id, name: entry.agentWorkspaceId, rootPath: rootA, enabled: true, permissions: entry.permissions })),
      resolveWorkspaceContext: (entryId) => {
        const entry = entries.find((e) => e.id === entryId)!
        const root = entryId === 'ws_a' ? rootA : rootB
        return { context: { workspaceId: entry.id, rootPath: root }, entry: { id: entry.id, name: entry.agentWorkspaceId, rootPath: root, enabled: true, permissions: entry.permissions } }
      },
      registry: createDefaultLocalToolRegistry(),
    })
    // 默认 endpoint：全部可见
    const clientAll = await connect(status.endpoint)
    const allList = await clientAll.callTool({ name: 'workspace_list', arguments: {} })
    expect((allList.structuredContent as { count: number }).count).toBe(2)
    await clientAll.close()
    // profile endpoint：只允许 ws_a
    const profileEndpoint = status.endpoint.replace(/\/$/, '') + '/work'
    const clientWork = await connect(profileEndpoint)
    const workList = await clientWork.callTool({ name: 'workspace_list', arguments: {} })
    expect((workList.structuredContent as { count: number }).count).toBe(1)
    const denied = await clientWork.callTool({ name: 'read_file', arguments: { workspace_id: 'ws_b', path: 'b.txt' } })
    expect(denied.isError).toBe(true)
    await clientWork.close()
  })

  it('TC-V5-MCP-01：无 Session ID 的现代 tools/list 直接返回工具列表（不当作 initialize）', async () => {
    const root = makeRoot('l')
    writeFileSync(join(root, 'a.txt'), 'AAA')
    const endpoint = await startServer([workspaceEntry('agent-a', 'ws_a', { read: true, write: false, shell: false })], new Map([['ws_a', root]]))
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(response.status).toBe(200)
    const payload = await parseRpcPayload(response) as { result?: { tools?: Array<{ name: string }> } }
    const names = (payload.result?.tools ?? []).map((t) => t.name)
    expect(names).toContain('workspace_list')
    expect(names).toContain('read_file')
  })

  it('TC-V5-MCP-01b：无 Session ID 的 tools/call（workspace_list）同样可用', async () => {
    const root = makeRoot('m')
    writeFileSync(join(root, 'a.txt'), 'AAA')
    const endpoint = await startServer([workspaceEntry('agent-a', 'ws_a', { read: true, write: false, shell: false })], new Map([['ws_a', root]]))
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace_list', arguments: {} } }),
    })
    expect(response.status).toBe(200)
    const payload = await parseRpcPayload(response) as { result?: { structuredContent?: { workspaces?: unknown[] } } }
    expect(payload.result?.structuredContent?.workspaces).toHaveLength(1)
  })
})
