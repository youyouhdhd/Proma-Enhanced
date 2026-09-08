/**
 * 搜索工具：search_text（文本内容搜索）/ find_files（文件名匹配）
 *
 * 零依赖实现：递归扫描 + 简单 glob→regex 转换；跳过 node_modules/.git 与二进制文件。
 */

import { readFileSync, readdirSync, statSync, lstatSync } from 'node:fs'
import { join, relative } from 'node:path'
import { guardWorkspacePath } from './security'
import { toolOk, toolError } from './types'
import type { LocalToolDefinition } from './types'

/** 单次搜索的结果上限 */
const MAX_SEARCH_HITS = 200
/** 单文件大小上限（超过跳过） */
const MAX_SCAN_BYTES = 1024 * 1024
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build'])
const TEXT_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'txt', 'css', 'scss', 'less', 'html', 'yml', 'yaml', 'toml', 'xml', 'sql', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'ps1', 'vue', 'svelte'])

function walkFiles(root: string, dir: string, out: string[], limit = 4000): void {
  if (out.length >= limit) return
  let names: string[]
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (out.length >= limit) return
    if (IGNORED_DIRS.has(name)) continue
    const full = join(dir, name)
    let stat
    try { stat = lstatSync(full) } catch { continue }
    if (stat.isSymbolicLink()) continue // 禁止递归跟随符号链接/junction（含循环和外部目录）
    if (stat.isDirectory()) walkFiles(root, full, out, limit)
    else if (stat.isFile()) out.push(full)
  }
}

/** 把 glob 模式（支持 ** 递归与 * 与 ? 通配）转成 regex */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::GLOBSTAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/::GLOBSTAR::/g, '.*')
  return new RegExp('^' + escaped + '$', 'i')
}

export const searchTextTool: LocalToolDefinition = {
  name: 'search_text',
  description: '在工作区文本文件中搜索关键字（大小写不敏感的子串匹配），返回命中行。',
  inputSchema: {
    type: 'object',
  required: ['query'],
    properties: {
      workspace_id: { type: 'string', description: '目标项目（workspace_list 返回的 id）；仅授权一个项目时可省略' },
      query: { type: 'string', description: '搜索关键字' },
      path: { type: 'string', description: '限定搜索的子目录，默认 "."' },
      glob: { type: 'string', description: '文件名过滤，如 "*.ts"' },
    },
  },
  risk: 'read',
  async execute(input, context) {
    const query = typeof input.query === 'string' ? input.query : ''
    if (!query.trim()) return toolError('INVALID_INPUT', 'query 不能为空')
    const rawPath = typeof input.path === 'string' && input.path.trim() ? input.path : '.'
    const guarded = guardWorkspacePath(context.rootPath, rawPath, { mustExist: true })
    if ('error' in guarded) return guarded
    const globFilter = typeof input.glob === 'string' && input.glob.trim() ? globToRegex(input.glob.trim()) : null
    const needle = query.toLowerCase()
    const files: string[] = []
    walkFiles(context.rootPath, guarded.path, files)
    const matches: Array<{ path: string; line: number; text: string }> = []
    let truncated = false
    for (const file of files) {
      if (matches.length >= MAX_SEARCH_HITS) { truncated = true; break }
      const dot = file.lastIndexOf('.')
      if (dot !== -1 && !TEXT_EXTS.has(file.slice(dot + 1).toLowerCase())) continue
      let content: string
      try {
        if (statSync(file).size > MAX_SCAN_BYTES) continue
        content = readFileSync(file, 'utf8')
      } catch { continue }
      if (content.includes('\0')) continue
      const lines = content.split(/\r?\n/)
      const rel = relative(context.rootPath, file).split('\\').join('/')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          if (matches.length >= MAX_SEARCH_HITS) { truncated = true; break }
          matches.push({ path: rel, line: i + 1, text: lines[i]!.trim().slice(0, 300) })
        }
      }
      void globFilter
    }
    return toolOk({ query, matches, count: matches.length, ...(truncated ? { truncated: true } : {}) })
  },
}

export const findFilesTool: LocalToolDefinition = {
  name: 'find_files',
  description: '按 glob 模式（如 "**/*oauth*.ts"）查找工作区内的文件路径。',
  inputSchema: {
    type: 'object',
  required: ['pattern'],
    properties: {
      workspace_id: { type: 'string', description: '目标项目（workspace_list 返回的 id）；仅授权一个项目时可省略' },
      pattern: { type: 'string', description: 'glob 模式，支持 ** / * / ?' },
      path: { type: 'string', description: '限定查找的子目录，默认 "."' },
    },
  },
  risk: 'read',
  async execute(input, context) {
    const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : ''
    if (!pattern) return toolError('INVALID_INPUT', 'pattern 不能为空')
    const rawPath = typeof input.path === 'string' && input.path.trim() ? input.path : '.'
    const guarded = guardWorkspacePath(context.rootPath, rawPath, { mustExist: true })
    if ('error' in guarded) return guarded
    const regex = globToRegex(pattern)
    const files: string[] = []
    walkFiles(context.rootPath, guarded.path, files)
    const matches: string[] = []
    let truncated = false
    for (const file of files) {
      const rel = relative(context.rootPath, file).split('\\').join('/')
      if (regex.test(rel)) {
        if (matches.length >= MAX_SEARCH_HITS) { truncated = true; break }
        matches.push(rel)
      }
    }
    void toolError
    return toolOk({ pattern, matches, count: matches.length, ...(truncated ? { truncated: true } : {}) })
  },
}
