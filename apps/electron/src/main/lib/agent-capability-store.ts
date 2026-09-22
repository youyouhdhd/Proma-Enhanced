import { cpSync, existsSync, lstatSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type {
  AgentCapabilityOverlay,
  GlobalAgentCapabilityConfig,
  GlobalAgentInstructionEntry,
  GlobalAgentMcpRegistryEntry,
  GlobalAgentProfile,
  GlobalAgentSkillRegistryEntry,
  PromoteAgentCapabilityInput,
  RemoveGlobalAgentCapabilityInput,
} from '@proma/shared'
import {
  getGlobalAgentCapabilitiesPath,
  getGlobalAgentSkillsDir,
  getWorkspaceAgentCapabilityOverlayPath,
  getWorkspaceSkillsDir,
} from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import {
  getAgentWorkspaceBySlug,
  getWorkspaceMcpConfig,
  getWorkspaceSkills,
  listAgentWorkspaces,
  normalizeWorkspaceMcpConfig,
  skillCopyFilter,
} from './agent-workspace-manager'
import { copyMcpCredentialScope } from './mcp-oauth-service'

export const GLOBAL_AGENT_CREDENTIAL_SCOPE = '__global_agent_capabilities__'

const EMPTY_PROFILE: GlobalAgentProfile = {
  schemaVersion: 1,
  skills: [],
  mcpServers: [],
  instructions: [],
  toolPolicy: { requiredDeniedTools: [], defaultDeniedTools: [] },
}

const DEFAULT_CONFIG: GlobalAgentCapabilityConfig = {
  schemaVersion: 1,
  enabled: true,
  profile: EMPTY_PROFILE,
}

function uniqueStrings(value: unknown, max = 200): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim()).slice(0, max))]
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value)
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path)
  return path === root || (!!rel && !rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel))
}

function normalizeSkills(value: unknown): GlobalAgentSkillRegistryEntry[] {
  if (!Array.isArray(value)) return []
  const root = resolve(getGlobalAgentSkillsDir())
  const result: GlobalAgentSkillRegistryEntry[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (!validId(item.id) || typeof item.slug !== 'string' || typeof item.directory !== 'string') continue
    const directory = resolve(item.directory)
    if (!isWithin(directory, root)) continue
    result.push({
      id: item.id,
      slug: item.slug.trim(),
      directory,
      defaultEnabled: item.defaultEnabled === true,
      ...(item.required === true ? { required: true } : {}),
      ...(!existsSync(join(directory, 'SKILL.md'))
        ? { status: 'missing' as const, reason: '全局 Skill 目录或 SKILL.md 不存在' }
        : {}),
    })
  }
  return result
}

function normalizeMcpServers(value: unknown): GlobalAgentMcpRegistryEntry[] {
  if (!Array.isArray(value)) return []
  const result: GlobalAgentMcpRegistryEntry[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (!validId(item.id) || typeof item.name !== 'string' || !item.server || typeof item.server !== 'object') continue
    const name = item.name.trim()
    if (!name) continue
    const server = normalizeWorkspaceMcpConfig({ servers: { [name]: item.server as never } }).servers[name]
    if (!server) continue
    // Global Registry 只保存可公开定义；环境变量和 Header 值必须经 Keychain 凭据作用域注入。
    const {
      lastTestResult: _lastTestResult,
      env: _env,
      headers: _headers,
      ...serverDefinition
    } = server
    const complete = (serverDefinition.type === 'stdio' && !!serverDefinition.command)
      || ((serverDefinition.type === 'http' || serverDefinition.type === 'sse') && !!serverDefinition.url)
    result.push({
      id: item.id,
      name,
      server: serverDefinition,
      credentialScope: GLOBAL_AGENT_CREDENTIAL_SCOPE,
      defaultEnabled: item.defaultEnabled === true,
      ...(item.required === true ? { required: true } : {}),
      ...(!complete ? { status: 'error' as const, reason: '全局 MCP 定义不完整' } : {}),
    })
  }
  return result
}

function normalizeInstructions(value: unknown): GlobalAgentInstructionEntry[] {
  if (!Array.isArray(value)) return []
  const result: GlobalAgentInstructionEntry[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (!validId(item.id) || typeof item.text !== 'string') continue
    const text = item.text.trim().slice(0, 12_000)
    result.push({
      id: item.id,
      text,
      defaultEnabled: item.defaultEnabled === true,
      ...(item.required === true ? { required: true } : {}),
      ...(!text ? { status: 'error' as const, reason: 'Instruction 内容为空' } : {}),
    })
  }
  return result
}

export function normalizeGlobalAgentCapabilityConfig(value: unknown): GlobalAgentCapabilityConfig {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const profile = root.profile && typeof root.profile === 'object' ? root.profile as Record<string, unknown> : {}
  const toolPolicy = profile.toolPolicy && typeof profile.toolPolicy === 'object'
    ? profile.toolPolicy as Record<string, unknown>
    : {}
  const model = profile.defaultModel && typeof profile.defaultModel === 'object'
    ? profile.defaultModel as Record<string, unknown>
    : undefined
  return {
    schemaVersion: 1,
    enabled: root.enabled !== false,
    profile: {
      schemaVersion: 1,
      skills: normalizeSkills(profile.skills),
      mcpServers: normalizeMcpServers(profile.mcpServers),
      instructions: normalizeInstructions(profile.instructions),
      toolPolicy: {
        requiredDeniedTools: uniqueStrings(toolPolicy.requiredDeniedTools),
        defaultDeniedTools: uniqueStrings(toolPolicy.defaultDeniedTools),
      },
      ...(model ? {
        defaultModel: {
          ...(typeof model.channelId === 'string' && model.channelId.trim() ? { channelId: model.channelId.trim() } : {}),
          ...(typeof model.modelId === 'string' && model.modelId.trim() ? { modelId: model.modelId.trim() } : {}),
        },
      } : {}),
    },
  }
}

export function normalizeAgentCapabilityOverlay(value: unknown): AgentCapabilityOverlay {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const toggles = (key: string): { enable?: string[]; disable?: string[] } | undefined => {
    const raw = root[key]
    if (!raw || typeof raw !== 'object') return undefined
    const record = raw as Record<string, unknown>
    const enable = uniqueStrings(record.enable)
    const disable = uniqueStrings(record.disable)
    return enable.length || disable.length ? { ...(enable.length ? { enable } : {}), ...(disable.length ? { disable } : {}) } : undefined
  }
  const rawInstructions = root.instructions && typeof root.instructions === 'object'
    ? root.instructions as Record<string, unknown>
    : undefined
  const addedInstructions = Array.isArray(rawInstructions?.add)
    ? rawInstructions.add.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const record = item as Record<string, unknown>
      if (!validId(record.id) || typeof record.text !== 'string' || !record.text.trim()) return []
      return [{ id: record.id, text: record.text.trim().slice(0, 12_000) }]
    })
    : []
  const instructionToggles = rawInstructions ? {
    enable: uniqueStrings(rawInstructions.enable),
    disable: uniqueStrings(rawInstructions.disable),
  } : undefined
  const rawPolicy = root.toolPolicy && typeof root.toolPolicy === 'object' ? root.toolPolicy as Record<string, unknown> : undefined
  const rawModel = root.model && typeof root.model === 'object' ? root.model as Record<string, unknown> : undefined
  return {
    ...(root.inheritGlobal === false ? { inheritGlobal: false } : {}),
    ...(toggles('skills') ? { skills: toggles('skills') } : {}),
    ...(toggles('mcpServers') ? { mcpServers: toggles('mcpServers') } : {}),
    ...(instructionToggles && (instructionToggles.enable.length || instructionToggles.disable.length || addedInstructions.length) ? {
      instructions: {
        ...(instructionToggles.enable.length ? { enable: instructionToggles.enable } : {}),
        ...(instructionToggles.disable.length ? { disable: instructionToggles.disable } : {}),
        ...(addedInstructions.length ? { add: addedInstructions } : {}),
      },
    } : {}),
    ...(rawPolicy ? {
      toolPolicy: {
        allow: uniqueStrings(rawPolicy.allow),
        deny: uniqueStrings(rawPolicy.deny),
      },
    } : {}),
    ...(rawModel ? {
      model: {
        ...(typeof rawModel.channelId === 'string' && rawModel.channelId.trim() ? { channelId: rawModel.channelId.trim() } : {}),
        ...(typeof rawModel.modelId === 'string' && rawModel.modelId.trim() ? { modelId: rawModel.modelId.trim() } : {}),
      },
    } : {}),
  }
}

export function getGlobalAgentCapabilityConfig(): GlobalAgentCapabilityConfig {
  return normalizeGlobalAgentCapabilityConfig(
    readJsonFileSafe<unknown>(getGlobalAgentCapabilitiesPath()) ?? DEFAULT_CONFIG,
  )
}

export function saveGlobalAgentCapabilityConfig(value: unknown): GlobalAgentCapabilityConfig {
  const normalized = normalizeGlobalAgentCapabilityConfig(value)
  const persisted: GlobalAgentCapabilityConfig = {
    ...normalized,
    profile: {
      ...normalized.profile,
      skills: normalized.profile.skills.map(({ status: _status, reason: _reason, ...entry }) => entry),
      mcpServers: normalized.profile.mcpServers.map(({ status: _status, reason: _reason, ...entry }) => entry),
      instructions: normalized.profile.instructions.map(({ status: _status, reason: _reason, ...entry }) => entry),
    },
  }
  writeJsonFileAtomic(getGlobalAgentCapabilitiesPath(), persisted)
  return normalizeGlobalAgentCapabilityConfig(persisted)
}

export function getProjectAgentCapabilityOverlay(workspaceSlug: string): AgentCapabilityOverlay {
  return normalizeAgentCapabilityOverlay(
    readJsonFileSafe<unknown>(getWorkspaceAgentCapabilityOverlayPath(workspaceSlug)) ?? {},
  )
}

export function saveProjectAgentCapabilityOverlay(workspaceSlug: string, value: unknown): AgentCapabilityOverlay {
  if (!getAgentWorkspaceBySlug(workspaceSlug)) throw new Error('Agent 项目不存在')
  const normalized = normalizeAgentCapabilityOverlay(value)
  writeJsonFileAtomic(getWorkspaceAgentCapabilityOverlayPath(workspaceSlug), normalized)
  return normalized
}

function appendToggle(current: string[] | undefined, id: string): string[] {
  return [...new Set([...(current ?? []), id])]
}

function promoteSkill(config: GlobalAgentCapabilityConfig, input: PromoteAgentCapabilityInput): string {
  const skill = getWorkspaceSkills(input.workspaceSlug).find(
    (candidate) => `workspace:${input.workspaceSlug}:skill:${candidate.slug}` === input.projectCapabilityId,
  )
  if (!skill) throw new Error('待提升的项目 Skill 不存在或未启用')
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(skill.slug)) throw new Error('Skill slug 不适合作为全局 Registry 标识')
  const source = join(getWorkspaceSkillsDir(input.workspaceSlug), skill.slug)
  if (!existsSync(source) || lstatSync(source).isSymbolicLink()) throw new Error('Skill 目录不可用或根目录为符号链接')
  const id = `global:skill:${skill.slug}`
  const target = join(getGlobalAgentSkillsDir(), skill.slug)
  if (!existsSync(target)) cpSync(source, target, { recursive: true, filter: skillCopyFilter })
  const existing = config.profile.skills.find((entry) => entry.id === id)
  const entry: GlobalAgentSkillRegistryEntry = {
    id,
    slug: skill.slug,
    directory: target,
    defaultEnabled: true,
  }
  config.profile.skills = existing
    ? config.profile.skills.map((item) => item.id === id ? entry : item)
    : [...config.profile.skills, entry]
  return id
}

function promoteMcp(config: GlobalAgentCapabilityConfig, input: PromoteAgentCapabilityInput): string {
  const prefix = `workspace:${input.workspaceSlug}:mcp:`
  if (!input.projectCapabilityId.startsWith(prefix)) throw new Error('MCP 能力 ID 与项目不匹配')
  const name = input.projectCapabilityId.slice(prefix.length)
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(name)) throw new Error('MCP 名称不适合作为全局 Registry 标识')
  const server = getWorkspaceMcpConfig(input.workspaceSlug).servers[name]
  if (!server) throw new Error('待提升的项目 MCP 不存在')
  const id = `global:mcp:${name}`
  const entry: GlobalAgentMcpRegistryEntry = {
    id,
    name,
    server,
    credentialScope: GLOBAL_AGENT_CREDENTIAL_SCOPE,
    defaultEnabled: true,
  }
  const existing = config.profile.mcpServers.find((item) => item.id === id)
  config.profile.mcpServers = existing
    ? config.profile.mcpServers.map((item) => item.id === id ? entry : item)
    : [...config.profile.mcpServers, entry]
  copyMcpCredentialScope(input.workspaceSlug, name, GLOBAL_AGENT_CREDENTIAL_SCOPE, name)
  return id
}

export function promoteAgentCapability(input: PromoteAgentCapabilityInput): GlobalAgentCapabilityConfig {
  if (!getAgentWorkspaceBySlug(input.workspaceSlug)) throw new Error('Agent 项目不存在')
  const config = getGlobalAgentCapabilityConfig()
  const globalId = input.kind === 'skill' ? promoteSkill(config, input) : promoteMcp(config, input)
  const saved = saveGlobalAgentCapabilityConfig(config)
  const overlay = getProjectAgentCapabilityOverlay(input.workspaceSlug)
  const key = input.kind === 'skill' ? 'skills' : 'mcpServers'
  const current = overlay[key]
  saveProjectAgentCapabilityOverlay(input.workspaceSlug, {
    ...overlay,
    [key]: {
      enable: appendToggle(current?.enable, globalId),
      disable: appendToggle(current?.disable, input.projectCapabilityId),
    },
  })
  return saved
}

export function removeGlobalAgentCapability(input: RemoveGlobalAgentCapabilityInput): GlobalAgentCapabilityConfig {
  const config = getGlobalAgentCapabilityConfig()
  const skill = input.kind === 'skill' ? config.profile.skills.find((item) => item.id === input.id) : undefined
  const mcp = input.kind === 'mcp' ? config.profile.mcpServers.find((item) => item.id === input.id) : undefined
  const instruction = input.kind === 'instruction' ? config.profile.instructions.find((item) => item.id === input.id) : undefined
  if (skill?.required || mcp?.required || instruction?.required) {
    throw new Error('Required 全局能力不能移除')
  }
  if (!skill && !mcp && !instruction) throw new Error('待移除的全局能力不存在')
  if (skill) config.profile.skills = config.profile.skills.filter((item) => item.id !== input.id)
  if (mcp) config.profile.mcpServers = config.profile.mcpServers.filter((item) => item.id !== input.id)
  if (instruction) config.profile.instructions = config.profile.instructions.filter((item) => item.id !== input.id)
  const saved = saveGlobalAgentCapabilityConfig(config)

  for (const workspace of listAgentWorkspaces()) {
    const overlay = getProjectAgentCapabilityOverlay(workspace.slug)
    if (skill) {
      saveProjectAgentCapabilityOverlay(workspace.slug, {
        ...overlay,
        skills: {
          enable: overlay.skills?.enable?.filter((id) => id !== input.id),
          disable: overlay.skills?.disable?.filter((id) => id !== `workspace:${workspace.slug}:skill:${skill.slug}`),
        },
      })
    } else if (mcp) {
      saveProjectAgentCapabilityOverlay(workspace.slug, {
        ...overlay,
        mcpServers: {
          enable: overlay.mcpServers?.enable?.filter((id) => id !== input.id),
          disable: overlay.mcpServers?.disable?.filter((id) => id !== `workspace:${workspace.slug}:mcp:${mcp.name}`),
        },
      })
    } else if (instruction) {
      saveProjectAgentCapabilityOverlay(workspace.slug, {
        ...overlay,
        instructions: {
          ...overlay.instructions,
          enable: overlay.instructions?.enable?.filter((id) => id !== input.id),
          disable: overlay.instructions?.disable?.filter((id) => id !== input.id),
        },
      })
    }
  }
  return saved
}
