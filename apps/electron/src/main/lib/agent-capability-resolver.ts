import { createHash } from 'node:crypto'
import type {
  AgentCapabilityOverlay,
  AgentCapabilityResolutionMeta,
  AgentCapabilitySource,
  AgentCapabilityStatus,
  AgentModelDefaults,
  EffectiveAgentCapabilities,
  GlobalAgentProfile,
  McpServerEntry,
  ResolvedAgentInstruction,
  ResolvedAgentMcpServer,
  ResolvedAgentSkill,
} from '@proma/shared'

export interface ProjectAgentCapabilityState {
  skills?: Array<{
    id: string
    slug: string
    directory: string
    enabled?: boolean
    status?: AgentCapabilityStatus
    reason?: string
  }>
  mcpServers?: Array<{
    id: string
    name: string
    server: McpServerEntry
    credentialScope?: string
    enabled?: boolean
    status?: AgentCapabilityStatus
    reason?: string
  }>
  instructions?: Array<{ id: string; text: string; enabled?: boolean }>
  deniedTools?: string[]
  model?: AgentModelDefaults
}

export interface ResolveEffectiveAgentCapabilitiesInput {
  globalProfile?: GlobalAgentProfile
  project?: ProjectAgentCapabilityState
  projectOverlay?: AgentCapabilityOverlay
  sessionOverlay?: AgentCapabilityOverlay
  turnOverlay?: AgentCapabilityOverlay
}

const EMPTY_PROFILE: GlobalAgentProfile = {
  schemaVersion: 1,
  skills: [],
  mcpServers: [],
  instructions: [],
  toolPolicy: { requiredDeniedTools: [], defaultDeniedTools: [] },
}

function resolution(
  source: AgentCapabilitySource,
  enabled: boolean,
  required = false,
  status: AgentCapabilityStatus = enabled ? 'ready' : 'disabled',
  reason?: string,
): AgentCapabilityResolutionMeta {
  return { source, enabled, required, status, ...(reason ? { reason } : {}) }
}

interface ResolvedItem {
  id: string
  resolution: AgentCapabilityResolutionMeta
}

function setProjectItem<T extends ResolvedItem>(map: Map<string, T>, item: T): void {
  const existing = map.get(item.id)
  if (existing?.resolution.required) {
    map.set(item.id, {
      ...existing,
      resolution: {
        ...existing.resolution,
        reason: 'Project 定义不能覆盖 Global Required 能力',
      },
    })
    return
  }
  map.set(item.id, item)
}

function setItemEnabled<T extends ResolvedItem>(item: T, enabled: boolean, source: AgentCapabilitySource): T {
  if (!enabled && item.resolution.required) {
    return {
      ...item,
      resolution: {
        ...item.resolution,
        reason: `${source} 不能禁用 Global Required 能力`,
      },
    }
  }
  const preservedStatus = item.resolution.status === 'missing' || item.resolution.status === 'error'
    ? item.resolution.status
    : enabled ? 'ready' : 'disabled'
  return {
    ...item,
    resolution: { ...item.resolution, source, enabled, status: preservedStatus },
  }
}

function applyToggleOverlay<T extends ResolvedItem>(
  map: Map<string, T>,
  overlay: { enable?: string[]; disable?: string[] } | undefined,
  source: AgentCapabilitySource,
  createMissing: (id: string, source: AgentCapabilitySource) => T,
): void {
  for (const id of overlay?.disable ?? []) {
    const item = map.get(id)
    map.set(id, item ? setItemEnabled(item, false, source) : createMissing(id, source))
  }
  for (const id of overlay?.enable ?? []) {
    const item = map.get(id)
    map.set(id, item ? setItemEnabled(item, true, source) : createMissing(id, source))
  }
}

function disableInheritedDefaults<T extends ResolvedItem>(map: Map<string, T>, source: AgentCapabilitySource): void {
  for (const [id, item] of map) {
    if (item.resolution.source === 'global-default' && !item.resolution.required) {
      map.set(id, setItemEnabled(item, false, source))
    }
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function hashCapabilities(capabilities: Omit<EffectiveAgentCapabilities, 'effectiveHash'>): string {
  const canonical = {
    resolverVersion: capabilities.resolverVersion,
    skills: capabilities.skills.map((item) => ({
      id: item.id,
      slug: item.slug,
      directory: item.directory,
      resolution: item.resolution,
    })),
    mcpServers: capabilities.mcpServers.map((item) => ({
      id: item.id,
      name: item.name,
      credentialScope: item.credentialScope,
      server: {
        type: item.server.type,
        command: item.server.command,
        args: item.server.args,
        envKeys: Object.keys(item.server.env ?? {}).sort(),
        url: item.server.url,
        headerKeys: Object.keys(item.server.headers ?? {}).sort(),
        timeout: item.server.timeout,
      },
      resolution: item.resolution,
    })),
    instructions: capabilities.instructions.map((item) => ({
      id: item.id,
      text: item.text,
      resolution: item.resolution,
    })),
    toolPolicy: capabilities.toolPolicy,
    model: capabilities.model,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

export function resolveEffectiveAgentCapabilities(
  input: ResolveEffectiveAgentCapabilitiesInput,
): EffectiveAgentCapabilities {
  const profile = input.globalProfile ?? EMPTY_PROFILE
  const skills = new Map<string, ResolvedAgentSkill>()
  const mcpServers = new Map<string, ResolvedAgentMcpServer>()
  const instructions = new Map<string, ResolvedAgentInstruction>()

  for (const entry of profile.skills) {
    const required = entry.required === true
    const enabled = required || entry.defaultEnabled
    skills.set(entry.id, {
      id: entry.id,
      slug: entry.slug,
      directory: entry.directory,
      resolution: resolution(required ? 'global-required' : 'global-default', enabled, required),
    })
  }
  for (const entry of profile.mcpServers) {
    const required = entry.required === true
    const enabled = required || entry.defaultEnabled
    mcpServers.set(entry.id, {
      id: entry.id,
      name: entry.name,
      server: entry.server,
      credentialScope: entry.credentialScope,
      resolution: resolution(required ? 'global-required' : 'global-default', enabled, required),
    })
  }
  for (const entry of profile.instructions) {
    const required = entry.required === true
    const enabled = required || entry.defaultEnabled
    instructions.set(entry.id, {
      id: entry.id,
      text: entry.text,
      resolution: resolution(required ? 'global-required' : 'global-default', enabled, required),
    })
  }

  for (const entry of input.project?.skills ?? []) {
    setProjectItem(skills, {
      id: entry.id,
      slug: entry.slug,
      directory: entry.directory,
      resolution: resolution('project', entry.enabled !== false, false, entry.status, entry.reason),
    })
  }
  for (const entry of input.project?.mcpServers ?? []) {
    setProjectItem(mcpServers, {
      id: entry.id,
      name: entry.name,
      server: entry.server,
      credentialScope: entry.credentialScope,
      resolution: resolution('project', entry.enabled !== false, false, entry.status, entry.reason),
    })
  }
  for (const entry of input.project?.instructions ?? []) {
    setProjectItem(instructions, {
      id: entry.id,
      text: entry.text,
      resolution: resolution('project', entry.enabled !== false),
    })
  }

  const requiredDeniedTools = new Set(profile.toolPolicy.requiredDeniedTools)
  const deniedTools = new Set([
    ...requiredDeniedTools,
    ...profile.toolPolicy.defaultDeniedTools,
    ...(input.project?.deniedTools ?? []),
  ])
  let model: EffectiveAgentCapabilities['model'] = profile.defaultModel
    ? { ...profile.defaultModel, source: 'global-default' }
    : undefined
  if (input.project?.model) model = { ...input.project.model, source: 'project' }

  const overlays: Array<{ value: AgentCapabilityOverlay | undefined; source: AgentCapabilitySource }> = [
    { value: input.projectOverlay, source: 'project' },
    { value: input.sessionOverlay, source: 'session' },
    { value: input.turnOverlay, source: 'turn' },
  ]
  for (const { value: overlay, source } of overlays) {
    if (!overlay) continue
    if (overlay.inheritGlobal === false) {
      disableInheritedDefaults(skills, source)
      disableInheritedDefaults(mcpServers, source)
      disableInheritedDefaults(instructions, source)
      if (model?.source === 'global-default') model = undefined
    }
    applyToggleOverlay(skills, overlay.skills, source, (id, missingSource) => ({
      id,
      slug: id,
      directory: '',
      resolution: resolution(missingSource, false, false, 'missing', `未找到 Skill 引用: ${id}`),
    }))
    applyToggleOverlay(mcpServers, overlay.mcpServers, source, (id, missingSource) => ({
      id,
      name: id,
      server: { type: 'stdio', enabled: false },
      resolution: resolution(missingSource, false, false, 'missing', `未找到 MCP 引用: ${id}`),
    }))
    applyToggleOverlay(instructions, overlay.instructions, source, (id, missingSource) => ({
      id,
      text: '',
      resolution: resolution(missingSource, false, false, 'missing', `未找到 Instruction 引用: ${id}`),
    }))
    for (const entry of overlay.instructions?.add ?? []) {
      const existing = instructions.get(entry.id)
      if (existing?.resolution.required) {
        instructions.set(entry.id, {
          ...existing,
          resolution: {
            ...existing.resolution,
            reason: `${source} 不能覆盖 Global Required Instruction`,
          },
        })
        continue
      }
      instructions.set(entry.id, {
        id: entry.id,
        text: entry.text,
        resolution: resolution(source, true),
      })
    }
    for (const tool of overlay.toolPolicy?.allow ?? []) {
      if (!requiredDeniedTools.has(tool)) deniedTools.delete(tool)
    }
    for (const tool of overlay.toolPolicy?.deny ?? []) deniedTools.add(tool)
    for (const tool of requiredDeniedTools) deniedTools.add(tool)
    if (overlay.model) model = { ...overlay.model, source }
  }

  const withoutHash: Omit<EffectiveAgentCapabilities, 'effectiveHash'> = {
    resolverVersion: 1,
    skills: [...skills.values()].sort((a, b) => a.id.localeCompare(b.id)),
    mcpServers: [...mcpServers.values()].sort((a, b) => a.id.localeCompare(b.id)),
    instructions: [...instructions.values()].sort((a, b) => a.id.localeCompare(b.id)),
    toolPolicy: {
      deniedTools: sortedUnique(deniedTools),
      requiredDeniedTools: sortedUnique(requiredDeniedTools),
    },
    ...(model ? { model } : {}),
  }
  return { ...withoutHash, effectiveHash: hashCapabilities(withoutHash) }
}
