/**
 * workspace_info — 获取当前 MCP workspace 描述（只读）
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { toolOk } from './types'
import type { LocalToolDefinition } from './types'

export const workspaceInfoTool: LocalToolDefinition = {
  name: 'workspace_info',
  description: '获取当前 MCP 绑定工作区的信息（名称、根路径、是否为 Git 仓库）。',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: { type: 'string', description: '目标项目（workspace_list 返回的 id）；仅授权一个项目时可省略' },
    },
  },
  risk: 'read',
  async execute(_input, context) {
    const { rootPath } = context
    const isGit = existsSync(resolve(rootPath, '.git'))
    let branch: string | undefined
    if (isGit) {
      const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootPath, encoding: 'utf8' })
      if (res.status === 0) branch = res.stdout.trim() || undefined
    }
    return toolOk({
      workspaceId: context.workspaceId,
      rootPath,
      git: isGit,
      ...(branch ? { branch } : {}),
    })
  },
}
