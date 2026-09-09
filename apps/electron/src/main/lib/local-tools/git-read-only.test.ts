import { it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitDiffTool, gitStatusTool } from './git-tools'

it('Given 带可执行过滤器的仓库 When 只读 Git 工具运行 Then 不执行过滤器且不向上读取父仓库', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proma-git-read-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' })
  try {
    git(['init', '--quiet'])
    writeFileSync(join(root, '.gitattributes'), '*.txt filter=unsafe diff=unsafe\n')
    writeFileSync(join(root, 'sample.txt'), 'old\n')
    git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--quiet', '-m', 'fixture'])
    const command = 'node -e "require(\'fs\').writeFileSync(\'UNSAFE_EXECUTED\',\'bad\')"'
    git(['config', 'filter.unsafe.clean', command]); git(['config', 'diff.unsafe.textconv', command]); git(['config', 'diff.external', command]); git(['config', 'core.fsmonitor', command])
    writeFileSync(join(root, 'sample.txt'), 'changed\n')
    const context = { rootPath: root, workspaceId: 'ws_test' }
    expect((await gitStatusTool.execute({}, context)).ok).toBe(true)
    expect((await gitDiffTool.execute({}, context)).ok).toBe(true)
    expect(existsSync(join(root, 'UNSAFE_EXECUTED'))).toBe(false)
    mkdirSync(join(root, 'subdir'))
    expect((await gitStatusTool.execute({}, { ...context, rootPath: join(root, 'subdir') })).ok).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
