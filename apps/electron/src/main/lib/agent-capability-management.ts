import type {
  AgentCapabilityManagementSnapshot,
  AgentCapabilityMigrationCandidate,
  AgentCapabilityOverlay,
  GlobalAgentCapabilityConfig,
  GlobalAgentProfile,
  PromoteAgentCapabilityInput,
  RemoveGlobalAgentCapabilityInput,
} from '@proma/shared'
import { listAgentWorkspaces, getWorkspaceMcpConfig, getWorkspaceSkills } from './agent-workspace-manager'
import { resolveWorkspaceAgentCapabilities } from './agent-capability-runtime'
import {
  getGlobalAgentCapabilityConfig,
  getProjectAgentCapabilityOverlay,
  promoteAgentCapability,
  removeGlobalAgentCapability,
  saveGlobalAgentCapabilityConfig,
  saveProjectAgentCapabilityOverlay,
} from './agent-capability-store'

function migrationCandidates(
  config: GlobalAgentCapabilityConfig,
  workspaceSlug: string,
  overlay: AgentCapabilityOverlay,
): AgentCapabilityMigrationCandidate[] {
  const candidates: AgentCapabilityMigrationCandidate[] = []
  for (const skill of getWorkspaceSkills(workspaceSlug)) {
    const projectCapabilityId = `workspace:${workspaceSlug}:skill:${skill.slug}`
    if (overlay.skills?.disable?.includes(projectCapabilityId)) continue
    if (config.profile.skills.some((entry) => entry.slug === skill.slug)) continue
    candidates.push({
      kind: 'skill',
      projectCapabilityId,
      name: skill.name,
      reason: 'not_global',
    })
  }
  for (const [name, server] of Object.entries(getWorkspaceMcpConfig(workspaceSlug).servers ?? {})) {
    const projectCapabilityId = `workspace:${workspaceSlug}:mcp:${name}`
    if (overlay.mcpServers?.disable?.includes(projectCapabilityId)) continue
    const global = config.profile.mcpServers.find((entry) => entry.name === name)
    if (!global) {
      candidates.push({
        kind: 'mcp',
        projectCapabilityId,
        name,
        reason: 'not_global',
      })
      continue
    }
    const comparable = (value: typeof server): string => JSON.stringify({
      type: value.type,
      command: value.command,
      args: value.args,
      envKeys: Object.keys(value.env ?? {}).sort(),
      url: value.url,
      headerKeys: Object.keys(value.headers ?? {}).sort(),
      timeout: value.timeout,
    })
    if (comparable(global.server) !== comparable(server)) {
      candidates.push({
        kind: 'mcp',
        projectCapabilityId,
        name,
        reason: 'same_name_different_definition',
      })
    }
  }
  return candidates
}

export function getAgentCapabilityManagementSnapshot(): AgentCapabilityManagementSnapshot {
  const config = getGlobalAgentCapabilityConfig()
  return {
    config,
    workspaces: listAgentWorkspaces().map((workspace) => {
      const overlay = getProjectAgentCapabilityOverlay(workspace.slug)
      return {
        workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
        overlay,
        effective: resolveWorkspaceAgentCapabilities(workspace.slug),
        migrationCandidates: migrationCandidates(config, workspace.slug, overlay),
      }
    }),
  }
}

export function setGlobalAgentCapabilitiesEnabled(enabled: boolean): AgentCapabilityManagementSnapshot {
  const config = getGlobalAgentCapabilityConfig()
  saveGlobalAgentCapabilityConfig({ ...config, enabled })
  return getAgentCapabilityManagementSnapshot()
}

export function updateGlobalAgentProfile(profile: GlobalAgentProfile): AgentCapabilityManagementSnapshot {
  const config = getGlobalAgentCapabilityConfig()
  saveGlobalAgentCapabilityConfig({ ...config, profile })
  return getAgentCapabilityManagementSnapshot()
}

export function updateProjectAgentCapabilityOverlay(
  workspaceSlug: string,
  overlay: AgentCapabilityOverlay,
): AgentCapabilityManagementSnapshot {
  saveProjectAgentCapabilityOverlay(workspaceSlug, overlay)
  return getAgentCapabilityManagementSnapshot()
}

export function promoteProjectAgentCapability(input: PromoteAgentCapabilityInput): AgentCapabilityManagementSnapshot {
  promoteAgentCapability(input)
  return getAgentCapabilityManagementSnapshot()
}

export function deleteGlobalAgentCapability(input: RemoveGlobalAgentCapabilityInput): AgentCapabilityManagementSnapshot {
  removeGlobalAgentCapability(input)
  return getAgentCapabilityManagementSnapshot()
}
