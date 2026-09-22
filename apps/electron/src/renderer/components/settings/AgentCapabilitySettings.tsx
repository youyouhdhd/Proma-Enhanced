import * as React from 'react'
import { ArrowUpToLine, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  AgentCapabilityManagementSnapshot,
  AgentCapabilityOverlay,
  AgentCapabilitySource,
  AgentCapabilityStatus,
  GlobalAgentProfile,
  RemoveGlobalAgentCapabilityInput,
} from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { SettingsCard, SettingsRow, SettingsSection, SettingsToggle } from './primitives'

const SOURCE_LABELS: Record<AgentCapabilitySource, string> = {
  'global-required': 'Global Required',
  'global-default': 'Global Default',
  project: 'Project',
  session: 'Session',
  turn: 'Turn',
}

const STATUS_LABELS: Record<AgentCapabilityStatus, string> = {
  ready: 'Ready',
  disabled: 'Disabled',
  error: 'Error',
  missing: 'Missing',
}

function StatusBadge({ status }: { status: AgentCapabilityStatus }): React.ReactElement {
  return (
    <Badge variant={status === 'error' || status === 'missing' ? 'destructive' : status === 'ready' ? 'secondary' : 'outline'}>
      {STATUS_LABELS[status]}
    </Badge>
  )
}

function LoadingSkeleton(): React.ReactElement {
  return (
    <div className="space-y-3" aria-label="正在加载 Agent 能力设置" aria-busy="true">
      {[0, 1, 2].map((item) => (
        <div key={item} className="h-20 animate-pulse rounded-lg border border-border/60 bg-muted/40" />
      ))}
    </div>
  )
}

function updateToggle(
  current: { enable?: string[]; disable?: string[] } | undefined,
  id: string,
  enabled: boolean,
): { enable?: string[]; disable?: string[] } {
  const enable = (current?.enable ?? []).filter((item) => item !== id)
  const disable = (current?.disable ?? []).filter((item) => item !== id)
  if (enabled) enable.push(id)
  else disable.push(id)
  return { ...(enable.length ? { enable } : {}), ...(disable.length ? { disable } : {}) }
}

export function AgentCapabilitySettings(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<AgentCapabilityManagementSnapshot | null>(null)
  const [selectedWorkspaceSlug, setSelectedWorkspaceSlug] = React.useState('')
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const [instructionId, setInstructionId] = React.useState('')
  const [instructionText, setInstructionText] = React.useState('')
  const [requiredDeniedTools, setRequiredDeniedTools] = React.useState('')
  const [defaultDeniedTools, setDefaultDeniedTools] = React.useState('')
  const [pendingRemove, setPendingRemove] = React.useState<RemoveGlobalAgentCapabilityInput | null>(null)

  const applySnapshot = React.useCallback((next: AgentCapabilityManagementSnapshot): void => {
    setSnapshot(next)
    setRequiredDeniedTools(next.config.profile.toolPolicy.requiredDeniedTools.join(', '))
    setDefaultDeniedTools(next.config.profile.toolPolicy.defaultDeniedTools.join(', '))
    setSelectedWorkspaceSlug((current) => next.workspaces.some((item) => item.workspace.slug === current)
      ? current
      : next.workspaces[0]?.workspace.slug ?? '')
  }, [])

  const load = React.useCallback(async (): Promise<void> => {
    setBusy('load')
    setError('')
    try {
      applySnapshot(await window.electronAPI.getAgentCapabilityManagement())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取 Agent 能力设置失败')
    } finally {
      setBusy(null)
    }
  }, [applySnapshot])

  React.useEffect(() => { void load() }, [load])

  const run = React.useCallback(async (
    key: string,
    action: () => Promise<AgentCapabilityManagementSnapshot>,
    success?: string,
  ): Promise<boolean> => {
    setBusy(key)
    setError('')
    try {
      applySnapshot(await action())
      if (success) toast.success(success)
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '操作失败'
      setError(message)
      toast.error(message)
      return false
    } finally {
      setBusy(null)
    }
  }, [applySnapshot])

  const selectedWorkspace = snapshot?.workspaces.find((item) => item.workspace.slug === selectedWorkspaceSlug)
  const profile = snapshot?.config.profile

  const saveProfile = React.useCallback((next: GlobalAgentProfile, key: string, success?: string) => (
    run(key, () => window.electronAPI.updateGlobalAgentCapabilityProfile(next), success)
  ), [run])

  const patchRegistryEntry = (
    kind: 'skills' | 'mcpServers' | 'instructions',
    id: string,
    patchValue: { defaultEnabled?: boolean; required?: boolean },
  ): void => {
    if (!profile) return
    const entries = profile[kind].map((entry) => entry.id === id
      ? { ...entry, ...patchValue, ...(patchValue.required === true ? { defaultEnabled: true } : {}) }
      : entry)
    void saveProfile({ ...profile, [kind]: entries }, `profile:${id}`)
  }

  const addInstruction = (): void => {
    if (!profile) return
    const id = instructionId.trim()
    const text = instructionText.trim()
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(id) || !text) {
      setError('Instruction 标识只能包含字母、数字、点、下划线、冒号或连字符，且内容不能为空。')
      return
    }
    const instructions = [...profile.instructions.filter((item) => item.id !== id), {
      id,
      text,
      defaultEnabled: true,
    }]
    void saveProfile({ ...profile, instructions }, `instruction:${id}`, '已保存全局 Instruction').then((saved) => {
      if (saved) {
        setInstructionId('')
        setInstructionText('')
      }
    })
  }

  const saveToolPolicy = (): void => {
    if (!profile) return
    const parse = (value: string) => [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
    void saveProfile({
      ...profile,
      toolPolicy: {
        requiredDeniedTools: parse(requiredDeniedTools),
        defaultDeniedTools: parse(defaultDeniedTools),
      },
    }, 'tool-policy', '已保存工具策略')
  }

  const updateOverlay = (overlay: AgentCapabilityOverlay, success?: string): void => {
    if (!selectedWorkspace) return
    void run('overlay', () => window.electronAPI.updateProjectAgentCapabilityOverlay(
      selectedWorkspace.workspace.slug,
      overlay,
    ), success)
  }

  const toggleProjectCapability = (kind: 'skills' | 'mcpServers', id: string, enabled: boolean): void => {
    if (!selectedWorkspace) return
    updateOverlay({
      ...selectedWorkspace.overlay,
      [kind]: updateToggle(selectedWorkspace.overlay[kind], id, enabled),
    })
  }

  if (!snapshot && busy === 'load') return <LoadingSkeleton />

  return (
    <div className="space-y-6">
      {error && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <SettingsSection
        title="Global Agent Capability Layer"
        description="全局定义只保存一次；项目只保存继承差异。关闭后立即回到原 Workspace 加载器。"
        action={<Button variant="ghost" size="sm" className="gap-1.5" onClick={() => void load()} disabled={busy !== null}><RefreshCw size={14} aria-hidden="true" />刷新</Button>}
      >
        <SettingsCard>
          <SettingsToggle
            label="启用全局 Agent 能力解析"
            description="空 Registry 与旧行为等价；关闭不会删除任何配置。"
            checked={snapshot?.config.enabled === true}
            disabled={!snapshot || busy !== null}
            onCheckedChange={(enabled) => void run('enabled', () => window.electronAPI.setGlobalAgentCapabilitiesEnabled(enabled))}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Global Registry" description="提升操作会复制 Skill 实体或 MCP 非敏感定义；凭据只在主进程 Keychain 内迁移。">
        <SettingsCard>
          {(profile?.skills ?? []).map((item) => (
            <SettingsRow key={item.id} label={item.slug} description={<span className="flex flex-wrap items-center gap-1.5"><span>{item.id}</span>{item.status && <StatusBadge status={item.status} />}</span>}>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">默认<Switch aria-label={`${item.slug} 默认启用`} checked={item.defaultEnabled || item.required === true} disabled={busy !== null || item.required === true} onCheckedChange={(checked) => patchRegistryEntry('skills', item.id, { defaultEnabled: checked })} /></label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">必需<Switch aria-label={`${item.slug} 设为必需`} checked={item.required === true} disabled={busy !== null} onCheckedChange={(checked) => patchRegistryEntry('skills', item.id, { required: checked })} /></label>
                <Button size="sm" variant="ghost" aria-label={`移除全局 Skill ${item.slug}`} disabled={busy !== null || item.required === true} onClick={() => setPendingRemove({ kind: 'skill', id: item.id })}><Trash2 size={14} aria-hidden="true" /></Button>
              </div>
            </SettingsRow>
          ))}
          {(profile?.mcpServers ?? []).map((item) => (
            <SettingsRow key={item.id} label={item.name} description={<span className="flex flex-wrap items-center gap-1.5"><span>{item.server.type}</span>{item.status && <StatusBadge status={item.status} />}</span>}>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">默认<Switch aria-label={`${item.name} 默认启用`} checked={item.defaultEnabled || item.required === true} disabled={busy !== null || item.required === true} onCheckedChange={(checked) => patchRegistryEntry('mcpServers', item.id, { defaultEnabled: checked })} /></label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">必需<Switch aria-label={`${item.name} 设为必需`} checked={item.required === true} disabled={busy !== null} onCheckedChange={(checked) => patchRegistryEntry('mcpServers', item.id, { required: checked })} /></label>
                <Button size="sm" variant="ghost" aria-label={`移除全局 MCP ${item.name}`} disabled={busy !== null || item.required === true} onClick={() => setPendingRemove({ kind: 'mcp', id: item.id })}><Trash2 size={14} aria-hidden="true" /></Button>
              </div>
            </SettingsRow>
          ))}
          {!profile?.skills.length && !profile?.mcpServers.length && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">Global Registry 为空，可从下方项目迁移候选显式提升。</div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Global Instructions 与工具策略" description="Required 工具拒绝不能被项目、Session 或单轮放宽。">
        <SettingsCard divided={false} className="space-y-4 p-4">
          <div className="grid gap-3 md:grid-cols-[minmax(160px,0.4fr)_1fr_auto]">
            <div><label htmlFor="global-instruction-id" className="mb-1 block text-sm font-medium">Instruction 标识</label><Input id="global-instruction-id" value={instructionId} onChange={(event) => setInstructionId(event.target.value)} placeholder="security-policy" /></div>
            <div><label htmlFor="global-instruction-text" className="mb-1 block text-sm font-medium">内容</label><Textarea id="global-instruction-text" value={instructionText} onChange={(event) => setInstructionText(event.target.value)} placeholder="适用于所有 Agent 运行的简短规则" className="min-h-20" /></div>
            <Button className="self-end gap-1.5" disabled={busy !== null} onClick={addInstruction}><Plus size={14} aria-hidden="true" />添加</Button>
          </div>
          {(profile?.instructions ?? []).map((item) => (
            <div key={item.id} className="flex items-start gap-3 rounded-md border border-border/60 bg-background/40 p-3">
              <div className="min-w-0 flex-1"><div className="text-sm font-medium">{item.id}</div><div className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{item.text}</div></div>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">默认<Switch aria-label={`${item.id} 默认启用`} checked={item.defaultEnabled || item.required === true} disabled={busy !== null || item.required === true} onCheckedChange={(checked) => patchRegistryEntry('instructions', item.id, { defaultEnabled: checked })} /></label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">必需<Switch aria-label={`${item.id} 设为必需`} checked={item.required === true} disabled={busy !== null} onCheckedChange={(checked) => patchRegistryEntry('instructions', item.id, { required: checked })} /></label>
              <Button size="sm" variant="ghost" aria-label={`移除全局 Instruction ${item.id}`} disabled={busy !== null || item.required === true} onClick={() => setPendingRemove({ kind: 'instruction', id: item.id })}><Trash2 size={14} aria-hidden="true" /></Button>
            </div>
          ))}
          <div className="grid gap-3 md:grid-cols-2">
            <div><label htmlFor="required-denied-tools" className="mb-1 block text-sm font-medium">Required 禁止工具</label><Textarea id="required-denied-tools" value={requiredDeniedTools} onChange={(event) => setRequiredDeniedTools(event.target.value)} placeholder="DangerousDelete, Bash" className="min-h-16" /></div>
            <div><label htmlFor="default-denied-tools" className="mb-1 block text-sm font-medium">Default 禁止工具</label><Textarea id="default-denied-tools" value={defaultDeniedTools} onChange={(event) => setDefaultDeniedTools(event.target.value)} placeholder="OptionalTool" className="min-h-16" /></div>
          </div>
          <Button variant="outline" disabled={busy !== null} onClick={saveToolPolicy}>保存工具策略</Button>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Project Overlay 与 Effective Inspector" description="项目只记录相对 Global Registry 的启用、禁用和附加规则。">
        {snapshot?.workspaces.length ? (
          <div className="space-y-3">
            <Select value={selectedWorkspaceSlug} onValueChange={setSelectedWorkspaceSlug}>
              <SelectTrigger className="max-w-sm" aria-label="选择 Agent 项目"><SelectValue /></SelectTrigger>
              <SelectContent>{snapshot.workspaces.map((item) => <SelectItem key={item.workspace.slug} value={item.workspace.slug}>{item.workspace.name}</SelectItem>)}</SelectContent>
            </Select>
            {selectedWorkspace && (
              <>
                <SettingsCard>
                  <SettingsToggle label="继承 Global Default" description="Global Required 始终生效。" checked={selectedWorkspace.overlay.inheritGlobal !== false} disabled={busy !== null} onCheckedChange={(checked) => updateOverlay({ ...selectedWorkspace.overlay, inheritGlobal: checked })} />
                  {[...(profile?.skills ?? []), ...(profile?.mcpServers ?? [])].map((item) => {
                    const kind = 'slug' in item ? 'skills' as const : 'mcpServers' as const
                    const effective = kind === 'skills'
                      ? selectedWorkspace.effective.skills.find((candidate) => candidate.id === item.id)
                      : selectedWorkspace.effective.mcpServers.find((candidate) => candidate.id === item.id)
                    return (
                      <SettingsRow key={item.id} label={'slug' in item ? item.slug : item.name} description={effective ? `${SOURCE_LABELS[effective.resolution.source]} · ${STATUS_LABELS[effective.resolution.status]}` : '未解析'}>
                        <Switch aria-label={`${item.id} 在当前项目启用`} checked={effective?.resolution.enabled === true} disabled={busy !== null || effective?.resolution.required === true} onCheckedChange={(checked) => toggleProjectCapability(kind, item.id, checked)} />
                      </SettingsRow>
                    )
                  })}
                </SettingsCard>

                <SettingsCard>
                  {selectedWorkspace.migrationCandidates.map((candidate) => (
                    <SettingsRow key={candidate.projectCapabilityId} label={candidate.name} description={candidate.reason === 'same_name_different_definition' ? '存在同名但定义不同的全局 MCP；请先移除或调整全局条目。' : `项目 ${candidate.kind === 'skill' ? 'Skill' : 'MCP'} 尚未进入 Global Registry。`}>
                      <Button variant="outline" size="sm" className="gap-1.5" disabled={busy !== null || candidate.reason === 'same_name_different_definition'} onClick={() => void run(`promote:${candidate.projectCapabilityId}`, () => window.electronAPI.promoteProjectAgentCapability({ workspaceSlug: selectedWorkspace.workspace.slug, kind: candidate.kind, projectCapabilityId: candidate.projectCapabilityId }), '已提升为全局能力')}><ArrowUpToLine size={14} aria-hidden="true" />提升为全局</Button>
                    </SettingsRow>
                  ))}
                  {!selectedWorkspace.migrationCandidates.length && <div className="px-4 py-6 text-center text-sm text-muted-foreground">没有待提升的项目能力。</div>}
                </SettingsCard>

                <div className="rounded-lg border border-border/60 bg-background/40 p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2"><ShieldCheck size={16} aria-hidden="true" /><span className="text-sm font-medium">Effective Inspector</span><code className="text-xs text-muted-foreground">{selectedWorkspace.effective.effectiveHash.slice(0, 12)}</code></div>
                  <div className="space-y-2">
                    {[...selectedWorkspace.effective.skills.map((item) => ({ id: item.id, label: item.slug, resolution: item.resolution })), ...selectedWorkspace.effective.mcpServers.map((item) => ({ id: item.id, label: item.name, resolution: item.resolution })), ...selectedWorkspace.effective.instructions.map((item) => ({ id: item.id, label: item.id, resolution: item.resolution }))].map((item) => (
                      <div key={item.id} className="flex items-center gap-2 text-sm"><span className="min-w-0 flex-1 truncate">{item.label}</span><Badge variant="outline">{SOURCE_LABELS[item.resolution.source]}</Badge><StatusBadge status={item.resolution.status} />{item.resolution.required && <Badge>Required</Badge>}</div>
                    ))}
                    {!selectedWorkspace.effective.skills.length && !selectedWorkspace.effective.mcpServers.length && !selectedWorkspace.effective.instructions.length && <div className="text-sm text-muted-foreground">当前没有可解释的 Agent 能力。</div>}
                  </div>
                  {!!selectedWorkspace.effective.toolPolicy.deniedTools.length && <div className="mt-3 text-xs text-muted-foreground">禁止工具：{selectedWorkspace.effective.toolPolicy.deniedTools.join(', ')}</div>}
                </div>
              </>
            )}
          </div>
        ) : <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">暂无 Agent 项目。</div>}
      </SettingsSection>

      <AlertDialog open={pendingRemove !== null} onOpenChange={(open) => { if (!open) setPendingRemove(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>移除全局能力？</AlertDialogTitle><AlertDialogDescription>Registry 条目和相关 Overlay 引用将被移除；已提升的原项目能力会恢复生效。Skill 实体与 Keychain 凭据会保留，便于后续恢复。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (!pendingRemove) return; const input = pendingRemove; setPendingRemove(null); void run(`remove:${input.id}`, () => window.electronAPI.removeGlobalAgentCapability(input), '已移除全局能力') }}>移除</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
