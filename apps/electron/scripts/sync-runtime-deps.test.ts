import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeJsonFileAtomic } from '../src/main/lib/safe-file'

test('Given hoisted 依赖与残留虚拟目录 When 默认同步运行时 Then 只复制当前安装版本', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proma-runtime-source-'))
  const scripts = join(root, 'apps', 'electron', 'scripts')
  const current = join(root, 'node_modules', 'fixture-runtime')
  const stale = join(root, 'node_modules', '.bun', 'node_modules', 'fixture-runtime')
  for (const directory of [scripts, current, stale]) mkdirSync(directory, { recursive: true })
  try {
    writeJsonFileAtomic(join(current, 'package.json'), { name: 'fixture-runtime', version: '1.0.0' })
    writeJsonFileAtomic(join(stale, 'package.json'), { name: 'fixture-runtime', version: '0.1.0' })
    const script = join(scripts, 'sync-runtime-deps.ts')
    copyFileSync(join(import.meta.dir, 'sync-runtime-deps.ts'), script)
    const module = await import(pathToFileURL(script).href) as typeof import('./sync-runtime-deps')
    const result = module.syncRuntimeDeps({ externalRuntimePackages: ['fixture-runtime'] })
    expect(result.copiedPackageCount).toBe(1)
    const copied = join(root, 'apps', 'electron', 'node_modules', 'fixture-runtime', 'package.json')
    expect(JSON.parse(readFileSync(copied, 'utf8')).version).toBe('1.0.0')
    expect(JSON.parse(readFileSync(join(stale, 'package.json'), 'utf8')).version).toBe('0.1.0')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
