import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillVersion } from './config-paths'

const skillDir = join(import.meta.dir, '../../../default-skills/proma-coach')
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
const reference = readFileSync(join(skillDir, 'references/enhanced-capability-map.md'), 'utf8')

describe('Proma Coach Enhanced Fork 指导契约', () => {
  test('Given 新版默认 Skill When 应用同步 Then 版本与按需 reference 入口完整', () => {
    expect(parseSkillVersion(skillDir)).toBe('1.0.14')
    expect(skill).toContain('[references/enhanced-capability-map.md](references/enhanced-capability-map.md)')
  })

  test('Given 用户询问 Enhanced 能力 When Coach 路由 Then 覆盖稳定心智模型而不改写原工作流', () => {
    for (const expected of [
      '### Step 1：诊断真实痛点',
      '### Step 2：搜索已有沉淀（先省再造）',
      '### Step 3：分类并设计或路由',
      '### Step 4：闭环',
      'Global Registry',
      'Project Overlay',
      'Effective Inspector',
      'QuickAsk',
      'Direct Tool',
      'Agent Delegation',
      'requested',
      'executed',
    ]) expect(skill).toContain(expected)
  })

  test('Given 全局与 Connector 边界 When Coach 给建议 Then reference 保留关键安全不变量', () => {
    for (const expected of [
      '不自动 Promote',
      '不绕过 Global Required',
      'ChatGPT 不能替用户批准',
      '不把 Token、Authorization Header、环境变量值或 Connector Secret',
      '不把 Proma 内部 Agent 能力当成 ChatGPT Connector 已获得的权限',
      '不用当前模型 Binding 改写历史 executed model',
    ]) expect(reference).toContain(expected)
  })
})
