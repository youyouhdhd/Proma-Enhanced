/**
 * 文件系统工具：list_files / read_file / write_file / edit_file
 *
 * 全部经 guardWorkspacePath 守卫（resolve + realpath 双重包含检查）。
 */

import { readFileSync, writeFileSync, readdirSync, statSync, lstatSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { guardWorkspacePath, ensureParentDir } from './security'
import { toolOk, toolError } from './types'
import type { LocalToolDefinition } from './types'

/** 单文件读取上限（字节） */
const MAX_READ_BYTES = 1024 * 1024
/** 二进制嗅探窗口 */
const BINARY_SNIFF_BYTES = 8192

function isProbablyBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, Math.min(BINARY_SNIFF_BYTES, buffer.length))
  return window.includes(0)
}

const listFilesInputSchema = {
  type: 'object',
  properties: {
    workspace_id: { type: 'string', description: '目标项目（workspace_list 返回的 id）；仅授权一个项目时可省略' },
    path: { type: 'string', description: '相对工作区根的目录路径，默认 "."' },
    depth: { type: 'number', description: '递归深度，默认 2，最大 5' },
  },
}

export const listFilesTool: LocalToolDefinition = {
  name: 'list_files',
  description: '列出工作区内目录的文件与子目录（受限递归）。自动忽略 node_modules 与 .git。',
  inputSchema: listFilesInputSchema,
  risk: 'read',
  async execute(input, context) {
    const rawPath = typeof input.path === 'string' && input.path.trim() ? input.path : '.'
    const depth = Math.min(Math.max(Number(input.depth ?? 2) || 2, 1), 5)
    const guarded = guardWorkspacePath(context.rootPath, rawPath, { mustExist: true })
    if ('error' in guarded) return guarded
    const entries: Array<{ name: string; path: string; type: 'file' | 'dir' }> = []
    const IGNORED = new Set(['node_modules', '.git'])
    const walk = (dir: string, level: number): void => {
      if (level > depth) return
      let names: string[]
      try { names = readdirSync(dir) } catch { return }
      for (const name of names.sort()) {
        if (IGNORED.has(name)) continue
        const full = join(dir, name)
        let isDir = false
        try {
          const entryStat = lstatSync(full)
          if (entryStat.isSymbolicLink()) continue // 包括 Windows junction，递归不可越过工作区边界
          isDir = entryStat.isDirectory()
        } catch { continue }
        const rel = relative(context.rootPath, full).split('\\').join('/')
        entries.push({ name, path: rel, type: isDir ? 'dir' : 'file' })
        if (isDir) walk(full, level + 1)
      }
    }
    walk(guarded.path, 1)
    return toolOk({ root: context.rootPath, entries, count: entries.length })
  },
}

export const readFileTool: LocalToolDefinition = {
  name: 'read_file',
  description: '读取工作区内文本文件的内容，可指定行范围（1 起始、闭区间）。',
  inputSchema: {
    type: 'object',
  required: ['path'],
    properties: {
      workspace_id: { type: 'string', description: '目标项目（workspace_list 返回的 id）；仅授权一个项目时可省略' },
      path: { type: 'string', description: '相对工作区根的文件路径' },
      startLine: { type: 'number', description: '起始行（1 起始）' },
      endLine: { type: 'number', description: '结束行（闭区间）' },
    },
  },
  risk: 'read',
  async execute(input, context) {
    const rawPath = typeof input.path === 'string' ? input.path : ''
    const guarded = guardWorkspacePath(context.rootPath, rawPath, { mustExist: true })
    if ('error' in guarded) return guarded
    let buffer: Buffer
    try { buffer = readFileSync(guarded.path) } catch {
      return toolError('EXECUTION_ERROR', '文件读取失败')
    }
    if (isProbablyBinary(buffer)) return toolError('BINARY_FILE', '目标看起来是二进制文件，无法以文本读取。')
    if (buffer.length > MAX_READ_BYTES) return toolError('EXECUTION_ERROR', `文件过大（>${Math.round(MAX_READ_BYTES / 1024)}KB），请用行范围分段读取。`)
    const lines = buffer.toString('utf8').split(/\r?\n/)
    const total = lines.length
    const start = Math.max(1, Math.floor(Number(input.startLine ?? 1) || 1))
    const end = Math.min(total, Math.floor(Number(input.endLine ?? total) || total))
    const content = lines.slice(Math.min(start, end) - 1, Math.max(start, end)).join('\n')
    return toolOk({ path: guarded.path, totalLines: total, startLine: Math.min(start, end), endLine: Math.max(start, end), content }, content)
  },
}

export const writeFileTool: LocalToolDefinition = {
  name: 'write_file',
  description: '在工作区内创建或整体覆盖一个文本文件（父目录自动创建）。',
  inputSchema: {
    type: 'object',
  required: ['path', 'content'],
    properties: {
      workspace_id: { type: 'string', description: '目标项目（workspace_list 返回的 id）；仅授权一个项目时可省略' },
      path: { type: 'string', description: '相对工作区根的文件路径' },
      content: { type: 'string', description: '完整文件内容（UTF-8）' },
    },
  },
  risk: 'write',
  async execute(input, context) {
    const rawPath = typeof input.path === 'string' ? input.path : ''
    const content = typeof input.content === 'string' ? input.content : ''
    const guarded = guardWorkspacePath(context.rootPath, rawPath)
    if ('error' in guarded) return guarded
    ensureParentDir(guarded.path)
    writeFileSync(guarded.path, content, 'utf8')
    return toolOk({ path: guarded.path, bytes: Buffer.byteLength(content, 'utf8') })
  },
}

export const editFileTool: LocalToolDefinition = {
  name: 'edit_file',
  description: '确定性编辑：oldText 必须在文件中唯一匹配，否则拒绝执行（不做模糊替换）。',
  inputSchema: {
    type: 'object',
  required: ['path', 'oldText', 'newText'],
    properties: {
      workspace_id: { type: 'string', description: '目标项目（workspace_list 返回的 id）；仅授权一个项目时可省略' },
      path: { type: 'string', description: '相对工作区根的文件路径' },
      oldText: { type: 'string', description: '要被替换的原文（必须唯一匹配）' },
      newText: { type: 'string', description: '替换后的文本' },
    },
  },
  risk: 'write',
  async execute(input, context) {
    const rawPath = typeof input.path === 'string' ? input.path : ''
    const oldText = typeof input.oldText === 'string' ? input.oldText : ''
    const newText = typeof input.newText === 'string' ? input.newText : ''
    if (!oldText) return toolError('INVALID_INPUT', 'oldText 不能为空')
    const guarded = guardWorkspacePath(context.rootPath, rawPath, { mustExist: true })
    if ('error' in guarded) return guarded
    let content: string
    try { content = readFileSync(guarded.path, 'utf8') } catch {
      return toolError('EXECUTION_ERROR', '文件读取失败')
    }
    const first = content.indexOf(oldText)
    if (first === -1) return toolError('MATCH_NOT_FOUND', 'oldText 在文件中未找到')
    const second = content.indexOf(oldText, first + 1)
    if (second !== -1) return toolError('MATCH_NOT_UNIQUE', 'oldText 在文件中匹配多次，请提供更长且唯一的片段')
    const updated = content.slice(0, first) + newText + content.slice(first + oldText.length)
    writeFileSync(guarded.path, updated, 'utf8')
    return toolOk({ path: guarded.path, replaced: true })
  },
}
