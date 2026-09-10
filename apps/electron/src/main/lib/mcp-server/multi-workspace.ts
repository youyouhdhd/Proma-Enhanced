/**
 * 多工作区 MCP 工具层（第二轮 P1：one MCP → workspace registry）
 *
 * 固定工具集 + workspace_id 参数（规范 §33/§36/§37/§38/§43）：
 * - 新增 workspace_list / read_many / git_status_batch；
 * - search_text 支持 workspace_ids 跨仓库搜索；
 * - 不为每个 Repo 动态创建工具——仓库只是运行时参数，ChatGPT 下次
 *   workspace_list 即可看到新增项目，无需刷新工具 schema；
 * - 不存在全局 activeWorkspace（规范 §34）：每次调用显式解析。
 */

import { existsSync } from 'node:fs'
import { runReadOnlyGit } from '../local-tools/git-tools'
import type { PromaMcpWorkspacePermissions } from '@proma/shared'
import { toolOk, toolError } from '../local-tools/types'
import type { LocalToolContext, LocalToolDefinition, LocalToolResult } from '../local-tools/types'
import type { LocalToolRegistry } from '../local-tools/registry'

/** 服务端注入的 workspace 解析器：entry id → 执行上下文 */
export type WorkspaceContextResolver = (entryId: string) => { context: LocalToolContext; entry: WorkspaceDirectoryEntry } | { error: string }

/** MCP 视角的一个 Workspace（rootPath 已在注册时解析验证） */
export interface WorkspaceDirectoryEntry {
  id: string
  name: string
  rootPath: string
  enabled: boolean
  permissions: PromaMcpWorkspacePermissions
}

// ===== 限制（规范 §37：防止一次调用把大量代码发给 ChatGPT） =====

const READ_MANY_MAX_FILES = 20
const READ_MANY_MAX_TOTAL_CHARS = 400_000
const CROSS_SEARCH_MAX_RESULTS = 200

// ===== 工具定义（schema 透出给 tools/list） =====

export const workspaceListTool: Pick<LocalToolDefinition, 'name' | 'description' | 'inputSchema' | 'risk'> = {
  name: 'workspace_list',
  description: '列出当前 MCP Gateway 暴露的全部授权项目（id、名称、Git 分支、权限）。跨仓库任务前先调用本工具获取 workspace_id。',
  inputSchema: { type: 'object', properties: {} },
  risk: 'read',
}

export const workspaceOpenTool: Pick<LocalToolDefinition, 'name' | 'description' | 'inputSchema' | 'risk'> = {
  name: 'workspace_open',
  description: '按 ID 或名称解析当前已授权项目，返回稳定 workspace_id。不会设置全局当前项目；后续调用显式传 workspace_id。',
  inputSchema: { type: 'object', properties: { workspace_id: { type: 'string' }, name: { type: 'string' } }, additionalProperties: false },
  risk: 'read',
}

export function handleWorkspaceOpen(args: Record<string, unknown>, entries: WorkspaceDirectoryEntry[]): LocalToolResult {
  const enabled = entries.filter((entry) => entry.enabled && entry.permissions.read)
  const candidates = typeof args.name === 'string' ? enabled.filter((entry) => entry.name === args.name) : enabled
  const resolved = resolveTargetWorkspace(args.workspace_id, candidates)
  if ('error' in resolved) return { ok: false, error: resolved.error }
  return toolOk({ workspace_id: resolved.entry.id, name: resolved.entry.name, permissions: resolved.entry.permissions })
}

export const readManyTool: Pick<LocalToolDefinition, 'name' | 'description' | 'inputSchema' | 'risk'> = {
  name: 'read_many',
  description: '一次读取多个（跨仓库）文件，减少往返。单次最多 20 个文件、总量 400KB。',
  inputSchema: {
    type: 'object',
    required: ['files'],
    properties: {
      files: {
        type: 'array',
        description: '文件列表，每项 { workspace_id, path }（path 相对该工作区根）',
        items: {
          type: 'object',
          required: ['workspace_id', 'path'],
          properties: {
            workspace_id: { type: 'string', description: 'workspace_list 返回的项目 id' },
            path: { type: 'string', description: '相对该工作区根的文件路径' },
          },
        },
      },
    },
  },
  risk: 'read',
}

export const gitStatusBatchTool: Pick<LocalToolDefinition, 'name' | 'description' | 'inputSchema' | 'risk'> = {
  name: 'git_status_batch',
  description: '批量查看多个工作区的 Git 状态（分支 + porcelain 列表）。不传 workspace_ids 时查看全部授权项目。',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_ids: { type: 'array', items: { type: 'string' }, description: '要查看的项目 id 列表；缺省 = 全部' },
    },
  },
  risk: 'read',
}

/** search_text 的跨仓库参数说明（拼进原 schema 描述由 server 侧组装） */
export const CROSS_SEARCH_SCHEMA_PROPERTIES = {
  workspace_ids: {
    type: 'array',
    items: { type: 'string' },
    description: '跨仓库搜索的项目 id 列表（可多个）；缺省 = 单工作区（配合 workspace_id 或默认）',
  },
} as const

// ===== 解析与权限 =====

/**
 * 把工具调用的 workspace_id 参数解析成目标 Workspace。
 * 规范 §35：仅授权一个 workspace 时可省略（默认便利行为）；多个时必须显式传。
 */
export function resolveTargetWorkspace(
  rawWorkspaceId: unknown,
  entries: WorkspaceDirectoryEntry[],
): { entry: WorkspaceDirectoryEntry } | { error: NonNullable<LocalToolResult['error']> } {
  const enabled = entries.filter((e) => e.enabled)
  if (typeof rawWorkspaceId === 'string' && rawWorkspaceId.trim()) {
    const id = rawWorkspaceId.trim()
    const entry = enabled.find((e) => e.id === id)
    if (!entry) {
      return { error: { code: 'INVALID_INPUT', message: '未知或未启用的 workspace_id: ' + id + '。可用: ' + enabled.map((e) => e.id).join(', ') } }
    }
    return { entry }
  }
  if (enabled.length === 1) return { entry: enabled[0]! }
  if (enabled.length === 0) {
    return { error: { code: 'INVALID_INPUT', message: 'MCP Gateway 尚未授权任何项目，请先在设置中选择。' } }
  }
  return {
    error: {
      code: 'WORKSPACE_REQUIRED',
      choices: enabled.map((entry) => ({ workspace_id: entry.id, name: entry.name })),
      message: '存在多个授权项目，必须显式指定 workspace_id。可用: ' + enabled.map((e) => e.id + '(' + e.name + ')').join(', ') + '。可先调用 workspace_list。',
    },
  }
}

/** 写入/执行类调用按 workspace 权限放行（规范 §39：按仓库独立管理） */
export function assertToolPermission(risk: 'read' | 'write' | 'execute', permissions: PromaMcpWorkspacePermissions): LocalToolResult['error'] | undefined {
  if (risk === 'read' && !permissions.read) return { code: 'PERMISSION_DENIED', message: '该 workspace 未授权读取' }
  if (risk === 'write' && !permissions.write) return { code: 'PERMISSION_DENIED', message: '该 workspace 未授权写入（只读项目）' }
  if (risk === 'execute' && !permissions.shell) return { code: 'PERMISSION_DENIED', message: '该 workspace 未授权执行命令' }
  return undefined
}

// ===== 工具实现 =====

/** workspace_list：包含每个项目的 git 状态（规范 §33 的返回形状） */
export async function handleWorkspaceList(entries: WorkspaceDirectoryEntry[]): Promise<LocalToolResult> {
  const workspaces = entries.map((entry) => {
    const isGit = entry.permissions.read && existsSync(entry.rootPath + '/.git')
    let branch: string | undefined
    if (isGit) {
      const res = runReadOnlyGit(entry.rootPath, ['symbolic-ref', '--short', 'HEAD'])
      if (res.status === 0) branch = res.stdout.trim() || undefined
    }
    return {
      id: entry.id,
      name: entry.name,
      git: isGit,
      ...(branch ? { branch } : {}),
      permissions: entry.permissions,
    }
  })
  return toolOk({ workspaces, count: workspaces.length })
}

/** read_many：跨仓库批量读取，带总量限制 */
export async function handleReadMany(
  input: Record<string, unknown>,
  entries: WorkspaceDirectoryEntry[],
  resolveContext: WorkspaceContextResolver,
  registry: LocalToolRegistry,
): Promise<LocalToolResult> {
  const rawFiles = Array.isArray(input.files) ? input.files : []
  if (rawFiles.length === 0) return toolError('INVALID_INPUT', 'files 不能为空')
  if (rawFiles.length > READ_MANY_MAX_FILES) {
    return toolError('INVALID_INPUT', '单次最多读取 ' + READ_MANY_MAX_FILES + ' 个文件，请分批调用')
  }
  const readFile = registry.get('read_file')
  if (!readFile) return toolError('EXECUTION_ERROR', 'read_file 工具未注册')
  const results: Array<{ workspace_id: string; path: string; ok: boolean; error?: string; content?: string; totalLines?: number }> = []
  let totalChars = 0
  let truncatedByBudget = false
  for (const rawFile of rawFiles) {
    if (totalChars >= READ_MANY_MAX_TOTAL_CHARS) { truncatedByBudget = true; break }
    if (!rawFile || typeof rawFile !== 'object') continue
    const item = rawFile as { workspace_id?: unknown; path?: unknown }
    const wsId = typeof item.workspace_id === 'string' ? item.workspace_id.trim() : ''
    const path = typeof item.path === 'string' ? item.path : ''
    if (!wsId || !path) {
      results.push({ workspace_id: wsId, path, ok: false, error: 'INVALID_INPUT: 需要 workspace_id 与 path' })
      continue
    }
    const resolved = resolveTargetWorkspace(wsId, entries)
    if ('error' in resolved) {
      results.push({ workspace_id: wsId, path, ok: false, error: resolved.error.code + ': ' + resolved.error.message })
      continue
    }
    const permissionError = assertToolPermission('read', resolved.entry.permissions)
    if (permissionError) {
      results.push({ workspace_id: wsId, path, ok: false, error: permissionError.code + ': ' + permissionError.message })
      continue
    }
    const ctx = resolveContext(wsId)
    if ('error' in ctx) {
      results.push({ workspace_id: wsId, path, ok: false, error: ctx.error })
      continue
    }
    const result = await readFile.execute({ path }, ctx.context)
    if (result.ok) {
      const content = typeof result.data?.content === 'string' ? result.data.content : ''
      const remaining = READ_MANY_MAX_TOTAL_CHARS - totalChars
      const clipped = content.length > remaining ? content.slice(0, remaining) : content
      totalChars += clipped.length
      if (clipped.length < content.length) truncatedByBudget = true
      results.push({
        workspace_id: wsId,
        path,
        ok: true,
        content: clipped,
        ...(typeof result.data?.totalLines === 'number' ? { totalLines: result.data.totalLines } : {}),
      })
    } else {
      results.push({ workspace_id: wsId, path, ok: false, ...(result.error ? { error: result.error.code + ': ' + result.error.message } : {}) })
    }
  }
  return toolOk({
    results,
    count: results.filter((r) => r.ok).length,
    ...(truncatedByBudget ? { truncated: true, message: '已按 400KB 预算截断，请分批读取' } : {}),
  })
}

/** git_status_batch：多仓库批量 git 状态（规范 §38） */
export async function handleGitStatusBatch(
  input: Record<string, unknown>,
  entries: WorkspaceDirectoryEntry[],
  resolveContext: WorkspaceContextResolver,
  registry: LocalToolRegistry,
): Promise<LocalToolResult> {
  const gitStatus = registry.get('git_status')
  if (!gitStatus) return toolError('EXECUTION_ERROR', 'git_status 工具未注册')
  const requestedIds = Array.isArray(input.workspace_ids)
    ? input.workspace_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : undefined
  const enabled = entries.filter((e) => e.enabled)
  const targets = requestedIds
    ? requestedIds.map((id) => enabled.find((e) => e.id === id)).filter((e): e is WorkspaceDirectoryEntry => e !== undefined)
    : enabled
  if (targets.length === 0) {
    return toolError('INVALID_INPUT', '没有匹配的已启用 workspace_id，可先调用 workspace_list')
  }
  const results: Array<{ workspace_id: string; ok: boolean; branch?: string; status?: string; error?: string }> = []
  for (const entry of targets) {
    const permissionError = assertToolPermission('read', entry.permissions)
    if (permissionError) {
      results.push({ workspace_id: entry.id, ok: false, error: permissionError.code + ': ' + permissionError.message })
      continue
    }
    const ctx = resolveContext(entry.id)
    if ('error' in ctx) {
      results.push({ workspace_id: entry.id, ok: false, error: ctx.error })
      continue
    }
    const result = await gitStatus.execute({}, ctx.context)
    if (result.ok) {
      results.push({
        workspace_id: entry.id,
        ok: true,
        ...(typeof result.data?.branch === 'string' ? { branch: result.data.branch } : {}),
        ...(typeof result.data?.status === 'string' ? { status: result.data.status } : {}),
      })
    } else {
      results.push({ workspace_id: entry.id, ok: false, ...(result.error ? { error: result.error.code + ': ' + result.error.message } : {}) })
    }
  }
  return toolOk({ results, count: results.length })
}

/** search_text 跨仓库模式：按 workspace_ids 聚合，结果带 workspace_id 标记（规范 §36） */
export async function handleCrossWorkspaceSearch(
  input: Record<string, unknown>,
  entries: WorkspaceDirectoryEntry[],
  resolveContext: WorkspaceContextResolver,
  registry: LocalToolRegistry,
): Promise<LocalToolResult> {
  const searchText = registry.get('search_text')
  if (!searchText) return toolError('EXECUTION_ERROR', 'search_text 工具未注册')
  const requestedIds = Array.isArray(input.workspace_ids)
    ? input.workspace_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  if (requestedIds.length === 0) {
    return toolError('INVALID_INPUT', '跨仓库搜索需要非空 workspace_ids')
  }
  const enabled = entries.filter((e) => e.enabled)
  const matches: Array<{ workspace_id: string; path: string; line: number; text: string }> = []
  const errors: Array<{ workspace_id: string; error: string }> = []
  let truncated = false
  for (const id of requestedIds) {
    const entry = enabled.find((e) => e.id === id)
    if (!entry) {
      errors.push({ workspace_id: id, error: '未知或未启用的 workspace_id' })
      continue
    }
    const permissionError = assertToolPermission('read', entry.permissions)
    if (permissionError) {
      errors.push({ workspace_id: id, error: permissionError.code + ': ' + permissionError.message })
      continue
    }
    const ctx = resolveContext(id)
    if ('error' in ctx) {
      errors.push({ workspace_id: id, error: ctx.error })
      continue
    }
    // 每个 workspace 独立传 path/glob；聚合时给每条命中打上 workspace_id 标记
    const perCallInput: Record<string, unknown> = { query: input.query }
    if (typeof input.path === 'string' && input.path.trim()) perCallInput.path = input.path
    if (typeof input.glob === 'string' && input.glob.trim()) perCallInput.glob = input.glob
    const result = await searchText.execute(perCallInput, ctx.context)
    if (result.ok) {
      const rawMatches = Array.isArray(result.data?.matches) ? result.data.matches as Array<{ path: string; line: number; text: string }> : []
      for (const match of rawMatches) {
        if (matches.length >= CROSS_SEARCH_MAX_RESULTS) { truncated = true; break }
        matches.push({ workspace_id: id, path: match.path, line: match.line, text: match.text })
      }
      if (result.data?.truncated === true) truncated = true
    } else if (result.error?.code !== 'MATCH_NOT_FOUND') {
      errors.push({ workspace_id: id, error: (result.error?.code ?? 'EXECUTION_ERROR') + ': ' + (result.error?.message ?? '搜索失败') })
    }
    if (matches.length >= CROSS_SEARCH_MAX_RESULTS) break
  }
  return toolOk({
    query: input.query,
    matches,
    count: matches.length,
    ...(errors.length > 0 ? { errors } : {}),
    ...(truncated ? { truncated: true } : {}),
  })
}
