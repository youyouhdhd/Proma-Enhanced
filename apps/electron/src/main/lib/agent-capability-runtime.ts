import { join } from 'node:path'
import type {
  AgentCapabilityOverlay,
  EffectiveAgentCapabilities,
  GlobalAgentProfile,
} from '@proma/shared'
import { getWorkspaceMcpConfig, getWorkspaceSkills } from './agent-workspace-manager'
import { getWorkspaceSkillsDir } from './config-paths'
import {
  resolveEffectiveAgentCapabilities,
  type ProjectAgentCapabilityState,
} from './agent-capability-resolver'
import {
  getGlobalAgentCapabilityConfig,
  getProjectAgentCapabilityOverlay,
} from './agent-capability-store'

export interface ResolveWorkspaceAgentCapabilitiesOptions {
  globalProfile?: GlobalAgentProfile
  projectOverlay?: AgentCapabilityOverlay
  sessionOverlay?: AgentCapabilityOverlay
  turnOverlay?: AgentCapabilityOverlay
}

export function buildProjectAgentCapabilityState(workspaceSlug: string | undefined): ProjectAgentCapabilityState {
  if (!workspaceSlug) return {}
  const skillsDirectory = getWorkspaceSkillsDir(workspaceSlug)
  const skills = getWorkspaceSkills(workspaceSlug).map((skill) => ({
    id: `workspace:${workspaceSlug}:skill:${skill.slug}`,
    slug: skill.slug,
    directory: join(skillsDirectory, skill.slug),
    enabled: skill.enabled,
  }))
  const mcpServers = Object.entries(getWorkspaceMcpConfig(workspaceSlug).servers ?? {}).map(([name, server]) => ({
    id: `workspace:${workspaceSlug}:mcp:${name}`,
    name,
    server,
    credentialScope: workspaceSlug,
    enabled: server.enabled,
  }))
  return { skills, mcpServers }
}

export function resolveWorkspaceAgentCapabilities(
  workspaceSlug: string | undefined,
  options: ResolveWorkspaceAgentCapabilitiesOptions = {},
): EffectiveAgentCapabilities {
  const stored = getGlobalAgentCapabilityConfig()
  const globalProfile = options.globalProfile ?? (stored.enabled ? stored.profile : undefined)
  const projectOverlay = options.projectOverlay
    ?? (stored.enabled && workspaceSlug ? getProjectAgentCapabilityOverlay(workspaceSlug) : undefined)
  return resolveEffectiveAgentCapabilities({
    globalProfile,
    project: buildProjectAgentCapabilityState(workspaceSlug),
    projectOverlay,
    sessionOverlay: options.sessionOverlay,
    turnOverlay: options.turnOverlay,
  })
}
