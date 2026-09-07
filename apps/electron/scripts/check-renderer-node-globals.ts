/**
 * Renderer Node 边界静态扫描（修复文档 §17/§18）
 *
 * 扫描 src/renderer 目录下全部 .ts / .tsx 文件，阻止新增对 Node runtime 的直接依赖：
 *   process.* / require() / __dirname / __filename / child_process / node: 前缀模块 / Buffer.*
 * Renderer 必须通过 preload bridge 访问系统能力；确有需要时移到 Main/Preload。
 *
 * 运行：bun run check:renderer-boundaries（发现违规时退出码 1）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const RENDERER_SRC = join(import.meta.dir, '..', 'src', 'renderer')

/** 违规模式（按修复文档 §18 最低集合） */
const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'process.*', regex: /\bprocess\s*\.\s*\w+/g },
  { name: 'require()', regex: /\brequire\s*\(/g },
  { name: '__dirname/__filename', regex: /\b__(?:dirname|filename)\b/g },
  { name: 'child_process', regex: /\bchild_process\b/g },
  { name: 'node: 模块导入', regex: /['\"]node:[a-z]/g },
  { name: 'Buffer.*', regex: /\bBuffer\s*\./g },
]

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) collectFiles(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const files = collectFiles(RENDERER_SRC).filter((file) => !/\.test\.(ts|tsx)$/.test(file))
const violations: string[] = []

for (const file of files) {
  const content = readFileSync(file, 'utf8')
  // 逐行扫描并报告行号（跳过 import type 行：类型引用不会进入产物）
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*import\s+type\b/.test(line) || /^\s*\/\//.test(line)) continue
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0
      const match = pattern.regex.exec(line)
      if (match) {
        violations.push(relative(process.cwd(), file) + ':' + (i + 1) + ' [' + pattern.name + '] ' + line.trim().slice(0, 120))
      }
    }
  }
}

if (violations.length > 0) {
  console.error('[renderer-boundaries] 发现 ' + violations.length + ' 处 Node 全局依赖，Renderer 禁止直接使用：')
  for (const v of violations) console.error('  ' + v)
  console.error('请改走 preload bridge，或把该逻辑移到 Main/Preload（修复文档 §17）。')
  process.exit(1)
}

console.log('[renderer-boundaries] OK：' + files.length + ' 个渲染层文件未发现 Node 全局依赖')
