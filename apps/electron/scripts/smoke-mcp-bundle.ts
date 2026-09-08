import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const appDir = resolve(import.meta.dir, '..')
const output = resolve(appDir, 'out/mcp-bundle-smoke.cjs')
mkdirSync(resolve(appDir, 'out'), { recursive: true })
await build({ entryPoints: [resolve(import.meta.dir, 'mcp-bundle-smoke-entry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: output })
const executable = process.argv[2] ?? (process.platform === 'win32' ? resolve(appDir, 'out/win-unpacked/Proma.exe') : 'node')
const result = spawnSync(executable, [output], {
  cwd: appDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, shell: false, windowsHide: true,
  encoding: 'utf8', timeout: 60_000,
})
if (result.stdout) console.log(result.stdout.trim())
if (result.stderr) console.error(result.stderr.trim())
if (result.status !== 0 || !result.stdout?.includes('runtime smoke PASS')) {
  console.error('MCP bundle 冒烟未通过：' + (result.error?.name ?? result.status ?? '无成功标记'))
  process.exitCode = 1
}
