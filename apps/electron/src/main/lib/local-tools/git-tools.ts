/**
 * Git 只读工具：git_status / git_diff
 *
 * 通过 spawnSync 在守卫后的工作区内执行只读 git 命令，带超时与输出上限。
 */

import { spawnSync } from 'node:child_process'
import { guardWorkspacePath } from './security'
import { toolOk, toolError } from './types'
import type { LocalToolDefinition } from './types'

const GIT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 200_000

function runGit(rootPath: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync('git', args, { cwd: rootPath, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true })
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
    let branch = runGit(context.rootPath, ['symbolic-ref', '--short', 'HEAD'])
    if (branch.status !== 0) branch = runGit(context.rootPath, ['rev-parse', '--short', 'HEAD'])
    if (branch.status !== 0) return toolError('GIT_ERROR', '当前目录不是 Git 仓库')
    const status = runGit(context.rootPath, ['status', '--porcelain=v1', '-b'])
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
    const args = ['diff', '--no-color']
    if (input.staged === true) args.push('--cached')
    if (typeof input.path === 'string' && input.path.trim()) {
      const guarded = guardWorkspacePath(context.rootPath, input.path, { mustExist: true })
      if ('error' in guarded) return guarded
      args.push(guarded.path)
    }
    const res = runGit(context.rootPath, args)
    if (res.status !== 0) return toolError('GIT_ERROR', res.stderr.trim() || 'git diff 执行失败')
    const diff = res.stdout.slice(0, MAX_OUTPUT_CHARS)
    return toolOk({ diff }, diff)
  },
}
