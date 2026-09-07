/**
 * 生产 Renderer 产物冒烟扫描（修复文档 §20/§21 最低可实现版本）
 *
 * 对 build:renderer 的产物（dist/renderer 目录下全部 .js）静态扫描：
 *   - process.platform / process.env 未替换调用
 * 命中即失败——这类调用在 contextIsolation + nodeIntegration:false 的
 * 渲染层会以 ReferenceError 形式白屏（TC-BLANK-01/02 的静态等价检查）。
 *
 * 已知 vendor 例外：shiki 主题惰性分块（bundle 内置平台探测，不在主路径执行）。
 * 运行：bun run smoke:renderer-dist（先 bun run build:renderer）
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const DIST = join(import.meta.dir, '..', 'dist', 'renderer')

/** vendor 例外（按 chunk 名前缀匹配；新增例外必须在此注释原因） */
const VENDOR_CHUNK_PREFIXES = [
  'cynefin-', // shiki 主题分块内的平台探测，惰性加载且非主路径
]

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) collectFiles(full, out)
    else if (/\.js$/.test(name)) out.push(full)
  }
  return out
}

const files = collectFiles(DIST)
if (files.length === 0) {
  console.error('[renderer-smoke] 未找到产物，请先运行 bun run build:renderer')
  process.exit(1)
}

const patterns: Array<{ name: string; regex: RegExp }> = [
  { name: 'process.platform', regex: /process\s*\.\s*platform/g },
  { name: 'process.env', regex: /process\s*\.\s*env\b/g },
]

const violations: string[] = []
for (const file of files) {
  const rel = relative(process.cwd(), file)
  if (VENDOR_CHUNK_PREFIXES.some((prefix) => file.includes(prefix))) continue
  const content = readFileSync(file, 'utf8')
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0
    const count = (content.match(pattern.regex) ?? []).length
    if (count > 0) violations.push(rel + ' [' + pattern.name + '] x' + count)
  }
}

if (violations.length > 0) {
  console.error('[renderer-smoke] 产物中存在未替换的 Node 全局调用：')
  for (const v of violations) console.error('  ' + v)
  console.error('这些调用会在生产渲染层抛 ReferenceError 导致白屏（修复文档 §3/§21）。')
  process.exit(1)
}

console.log('[renderer-smoke] OK：' + files.length + ' 个产物文件未发现未替换的 process.* 调用')
