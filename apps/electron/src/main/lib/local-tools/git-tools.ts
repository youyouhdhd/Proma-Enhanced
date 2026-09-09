/**
 * Git 只读工具：git_status / git_diff
 *
 * 通过 spawnSync 在守卫后的工作区内执行只读 git 命令，带超时与输出上限。
 */

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { guardWorkspacePath } from './security'
import { toolOk, toolError } from './types'
import type { LocalToolDefinition } from './types'

const GIT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 200_000

export function runReadOnlyGit(rootPath: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1' }
  delete (env as NodeJS.ProcessEnv).GIT_DIR; delete (env as NodeJS.ProcessEnv).GIT_WORK_TREE; delete (env as NodeJS.ProcessEnv).GIT_EXTERNAL_DIFF
  const prefix = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=']
  const options = { cwd: rootPath, env, encoding: 'utf8' as const, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }
  const top = spawnSync('git', [...prefix, 'rev-parse', '--show-toplevel'], options)
  try {
    const normalize = (path: string) => process.platform === 'win32' ? realpathSync(resolve(path)).toLowerCase() : realpathSync(resolve(path))
    if (top.status !== 0 || normalize(top.stdout.trim()) !== normalize(rootPath)) return { status: 1, stdout: '', stderr: '共享目录必须是独立 Git 根目录，不能向上读取其他目录的仓库' }
  } catch { return { status: 1, stdout: '', stderr: 'Git 根目录不可用' } }
  // 禁止 clean/process/textconv/external-diff 让“读取”启动仓库提供的外部程序。
  const filterNames = spawnSync('git', [...prefix, 'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], options)
  if (filterNames.status !== 0 && filterNames.status !== 1) return { status: 1, stdout: '', stderr: 'Git 过滤器配置无法安全解析' }
  for (const key of filterNames.stdout.split('\0').filter(Boolean)) prefix.push('-c', key + (key.endsWith('.required') ? '=false' : '='))
  const res = spawnSync('git', [...prefix, ...args], options)
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status }
}

export const gitStatusTool: LocalToolDefinition = {
  name: 'git_status',
  description: '查看工作区 Git 状态（分支 + porcelain 状态列表），无任何副作用。',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: { type: 'string', description: '目标项目（workspace_list 返回的 id）；仅授权一个项目时可省略' },
    },
  },
  risk: 'read',
  async execute(_input, context) {
    let branch = runReadOnlyGit(context.rootPath, ['symbolic-ref', '--short', 'HEAD'])
    if (branch.status !== 0) branch = runReadOnlyGit(context.rootPath, ['rev-parse', '--short', 'HEAD'])
    if (branch.status !== 0) return toolError('GIT_ERROR', '当前目录不是 Git 仓库')
    const status = runReadOnlyGit(context.rootPath, ['status', '--porcelain=v1', '-b'])
    if (status.status !== 0) return toolError('GIT_ERROR', status.stderr.trim() || 'git status 执行失败')
    return toolOk({ branch: branch.stdout.trim(), status: status.stdout.slice(0, MAX_OUTPUT_CHARS) }, status.stdout.slice(0, MAX_OUTPUT_CHARS))
  },
}

export const gitDiffTool: LocalToolDefinition = {
  name: 'git_diff',
  description: '查看工作区 Git diff（默认未暂存改动；staged=true 查看暂存区；可限定路径）。',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: { type: 'string', description: '目标项目（workspace_list 返回的 id）；仅授权一个项目时可省略' },
      staged: { type: 'boolean', description: 'true 时查看暂存区 diff' },
      path: { type: 'string', description: '限定 diff 的相对路径' },
    },
  },
  risk: 'read',
  async execute(input, context) {
    const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
    if (input.staged === true) args.push('--cached')
    if (typeof input.path === 'string' && input.path.trim()) {
      const guarded = guardWorkspacePath(context.rootPath, input.path, { mustExist: true })
      if ('error' in guarded) return guarded
      args.push('--', guarded.path)
    }
    const res = runReadOnlyGit(context.rootPath, args)
    if (res.status !== 0) return toolError('GIT_ERROR', res.stderr.trim() || 'git diff 执行失败')
    const diff = res.stdout.slice(0, MAX_OUTPUT_CHARS)
    return toolOk({ diff }, diff)
  },
}
