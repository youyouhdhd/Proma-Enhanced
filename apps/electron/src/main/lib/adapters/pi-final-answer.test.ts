import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 真实SDK必须隔离已有测试的全局mock，不能把假SessionManager当运行时。
describe('完整Pi Adapter补答：HTTP、一次工具和落盘', () => {
  for (const mode of ['normal', 'recover', 'empty', 'unexpected-tool', 'http-error', 'limit', 'cancel', 'interrupt']) {
    test(`Given ${mode} When 原任务完成/补答 Then 工具不重复且终态唯一`, () => {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./pi-final-answer.fixture.ts', import.meta.url)), mode], { encoding: 'utf8', timeout: 30000 })
      expect(result.status, result.stderr || result.error?.message).toBe(0)
    }, 35000)
  }
})
