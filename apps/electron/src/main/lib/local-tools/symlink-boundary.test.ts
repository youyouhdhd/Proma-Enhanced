import { expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDefaultLocalToolRegistry } from './registry'

it('Given 外部目录 junction/符号链接 When 列目录、查文件、全文搜索 Then 不跟随链接', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'proma-link-boundary-'))
  try {
    const root = join(temp, 'workspace')
    const outside = join(temp, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'private.txt'), 'outside-secret-marker')
    symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(root, 'visible.txt'), 'local-marker')
    const registry = createDefaultLocalToolRegistry()
    for (const [name, input] of [
      ['list_files', {}], ['find_files', { pattern: '**' }], ['search_text', { query: 'marker' }],
    ] as const) {
      const result = await registry.execute(name, input, { workspaceId: 'ws', rootPath: root })
      expect(result.ok).toBe(true)
      expect(JSON.stringify(result)).not.toContain('private.txt')
      expect(JSON.stringify(result)).not.toContain('outside-secret-marker')
      expect(JSON.stringify(result)).toContain('visible.txt')
    }
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
