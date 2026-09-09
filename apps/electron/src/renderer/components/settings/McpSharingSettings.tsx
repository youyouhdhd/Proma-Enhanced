import * as React from 'react'
import { atom, useAtom, useSetAtom } from 'jotai'
import { REMOTE_PROVIDERS } from '@proma/shared'
import type { McpSharingConfig, McpShareRoot, McpShareRootHealth, McpRemoteTask, PromaRemoteAccessConfig, McpTransportStatus, McpRemoteProviderKind, AgentWorkspace, Channel } from '@proma/shared'
import { settingsTabAtom } from '@/atoms/settings-tab'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'

interface SharingViewState {
  savedSharing?: McpSharingConfig; draftSharing?: McpSharingConfig
  savedRemote?: PromaRemoteAccessConfig; draftRemote?: PromaRemoteAccessConfig
  runtime?: McpTransportStatus; health: McpShareRootHealth[]; tasks: McpRemoteTask[]
  projects: AgentWorkspace[]; channels: Array<Pick<Channel, 'id' | 'name' | 'models'>>
  sharingDirty: boolean; remoteDirty: boolean; message: string; busy: Record<string, boolean>
  schemaBaseline?: string; schemaChanged: boolean; guide: Record<string, string>
}
const viewAtom = atom<SharingViewState>({ health: [], tasks: [], projects: [], channels: [], sharingDirty: false, remoteDirty: false, message: '', busy: {}, schemaChanged: false, guide: {} })
const intentAtom = atom<'stable' | 'test' | 'external' | 'experimental'>('stable')
const selectClass = 'w-full rounded-md border border-input bg-background p-2 text-sm'

export function McpSharingSettings(): React.ReactElement {
  const [view, setView] = useAtom(viewAtom)
  const [intent, setIntent] = useAtom(intentAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const tokenInput = React.useRef<HTMLInputElement>(null)
  const projectSelect = React.useRef<HTMLSelectElement>(null)
  const refresh = React.useCallback(async () => {
    const [sharing, remote] = await Promise.all([window.electronAPI.getMcpSharing(), window.electronAPI.getMcpTransport()])
    setView((old) => ({ ...old, savedSharing: sharing.config, draftSharing: old.sharingDirty ? old.draftSharing : sharing.config,
      savedRemote: remote.config, draftRemote: old.remoteDirty ? old.draftRemote : remote.config, runtime: remote.status, health: sharing.health, tasks: sharing.tasks,
      schemaBaseline: remote.status.confirmedToolSchemaFingerprint,
      schemaChanged: remote.status.confirmedToolSchemaFingerprint !== undefined && remote.status.confirmedToolSchemaFingerprint !== remote.status.toolSchemaFingerprint }))
  }, [setView])
  const refreshChoices = async () => {
    const [projects, channels] = await Promise.all([window.electronAPI.listAgentWorkspaces(), window.electronAPI.listChannels()])
    setView((old) => ({ ...old, projects, channels: channels.filter((c) => c.enabled).map(({ id, name, models }) => ({ id, name, models: models.filter((m) => m.enabled) })) }))
  }
  React.useEffect(() => {
    if ((window.electronAPI?.bridgeVersion ?? 0) < 11) return
    const update = () => { void refresh().catch(() => setView((old) => ({ ...old, message: '共享后台暂不可用，请重试或完整重启 Proma。' }))) }
    update(); void refreshChoices().catch(() => undefined)
    const dispose = [window.electronAPI.onMcpSharingChanged(update), window.electronAPI.onMcpRemoteConfigChanged(update), window.electronAPI.onMcpRemoteStatusChanged(update)]
    const timer = setInterval(update, 30000)
    window.addEventListener('focus', update)
    return () => { dispose.forEach((fn) => fn()); clearInterval(timer); window.removeEventListener('focus', update) }
  }, [refresh])
  const run = async (key: string, action: () => Promise<void>) => {
    setView((old) => ({ ...old, busy: { ...old.busy, [key]: true }, message: '' }))
    try { await action(); await refresh() } catch (error) { setView((old) => ({ ...old, message: error instanceof Error ? error.message : '操作失败' })) }
    finally { setView((old) => ({ ...old, busy: { ...old.busy, [key]: false } })) }
  }
  const message = (text: string) => setView((old) => ({ ...old, message: text }))
  if (typeof window === 'undefined' || (window.electronAPI?.bridgeVersion ?? 0) < 11) return <SettingsSection title="ChatGPT / MCP 共享" description="后台版本过旧，请完全退出并重启 Proma。"><p>需要 bridge 11 或更高版本。</p></SettingsSection>
  const sharing = view.draftSharing
  const remote = view.draftRemote
  if (!sharing || !remote) return <SettingsSection title="ChatGPT / MCP 共享" description="正在读取共享配置"><p role="status">{view.message}</p></SettingsSection>
  const patchSharing = (patch: Partial<McpSharingConfig>) => setView((old) => ({ ...old, sharingDirty: true, draftSharing: { ...old.draftSharing!, ...patch } }))
  const patchRemote = (patch: Partial<PromaRemoteAccessConfig>) => setView((old) => ({ ...old, remoteDirty: true, draftRemote: { ...old.draftRemote!, ...patch } }))
  const updateRoot = (id: string, patch: Partial<McpShareRoot>) => patchSharing({ roots: sharing.roots.map((r) => r.id === id ? { ...r, ...patch } : r) })
  const saveSharing = async () => {
    const saved = await window.electronAPI.saveMcpSharing(sharing)
    setView((old) => { const unchanged = JSON.stringify(old.draftSharing) === JSON.stringify(sharing); return { ...old, savedSharing: saved, draftSharing: unchanged ? saved : old.draftSharing, sharingDirty: !unchanged } })
    message('共享内容已保存；内容和读取权限变化不会重连网络。')
  }
  const saveRemote = async () => {
    const saved = await window.electronAPI.saveMcpTransport(remote)
    setView((old) => { const unchanged = JSON.stringify(old.draftRemote) === JSON.stringify(remote); return { ...old, savedRemote: saved, draftRemote: unchanged ? saved : old.draftRemote, remoteDirty: !unchanged } })
  }
  const provider = REMOTE_PROVIDERS.find((p) => p.kind === remote.provider)
  const selected = remote.provider ? remote.providers[remote.provider] ?? {} : {}
  const setProviderSettings = (value: typeof selected) => { if (remote.provider) patchRemote({ providers: { ...remote.providers, [remote.provider]: { ...selected, ...value } } }) }
  const live = view.runtime
  const connected = live && ['starting', 'preflight', 'ready', 'degraded'].includes(live.phase)
  const channel = view.channels.find((c) => c.id === sharing.delegation.channelId)
  const modelReady = Boolean(channel?.models.some((m) => m.id === sharing.delegation.modelId))
  return <SettingsSection title="ChatGPT / MCP 共享" description="先选择共享内容，再决定直接读取还是交给 PROMA 分析，最后连接 ChatGPT。">
    <div className="space-y-4">
      <SettingsCard divided={false}><div className="p-4 space-y-3">
        <h3 className="text-sm font-semibold">① 共享给 ChatGPT 的内容</h3>
        <p className="text-xs text-muted-foreground">只有明确授权的项目和文件夹才会出现在 MCP 中。远程默认继承这份共享列表，无需再勾一遍。</p>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={sharing.enabled} onChange={(e) => patchSharing({ enabled: e.target.checked })} />启用 MCP 共享</label>
        {view.sharingDirty && <p className="text-xs text-muted-foreground">共享内容或能力有未保存更改，保存后立即按新授权执行。</p>}
        {!sharing.roots.length && <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">尚未共享任何内容。添加 PROMA 项目或其他文件夹。</p>}
        {sharing.roots.map((root) => {
          const health = view.health.find((h) => h.id === root.id)
          const kind = health?.kind ?? (root.source.type === 'local-folder' ? 'extra-folder' : 'managed-project')
          return <div key={root.id} className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center gap-2"><input aria-label={'共享 ' + root.name} type="checkbox" checked={root.enabled} onChange={(e) => updateRoot(root.id, { enabled: e.target.checked })} />
              <span className="shrink-0 rounded bg-muted px-2 py-1 text-xs">{kind === 'extra-folder' ? '额外文件夹' : kind === 'local-project' ? '本地项目' : 'Proma 项目'}</span>
              <Input className="min-w-0 flex-1" aria-label="共享名称" value={root.name} onChange={(e) => updateRoot(root.id, { name: e.target.value })} />
              <Button size="sm" variant="ghost" onClick={() => patchSharing({ roots: sharing.roots.filter((r) => r.id !== root.id) })}>移除共享</Button>
            </div>
            <div className="break-all text-xs text-muted-foreground">{health?.path ?? (root.source.type === 'local-folder' ? root.source.path : root.source.agentWorkspaceId)}</div>
            <div className="flex flex-wrap gap-3 text-xs"><span>{health?.state === 'available' ? '✓ 可访问' : health?.message ?? '保存后检查目录'}</span><label><input type="checkbox" checked={root.permissions.read} onChange={(e) => updateRoot(root.id, { permissions: { ...root.permissions, read: e.target.checked } })} /> 允许读取</label></div>
            {root.source.type === 'local-folder' && <details><summary className="text-xs">需要让 PROMA 分析这个文件夹？</summary><p className="my-2 text-xs text-muted-foreground">先在 Proma 从这个目录创建项目，再在此关联同目录项目；不会隐式创建 Agent Workspace。</p><select aria-label="关联已有项目" className={selectClass} value="" onChange={(e) => { const workspaceId = e.currentTarget.value; if (workspaceId) void run('sharing', async () => { await saveSharing(); const linked = await window.electronAPI.linkMcpShareProject(root.id, workspaceId); setView((old) => ({ ...old, draftSharing: linked, sharingDirty: false })) }) }}><option value="">选择同目录的已有项目</option>{view.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></details>}
          </div>
        })}
        <div className="flex flex-wrap gap-2"><select ref={projectSelect} aria-label="添加 Proma 项目" className={selectClass}><option value="">选择已有 Proma / 本地项目</option>{view.projects.filter((p) => !sharing.roots.some((r) => r.source.type === 'agent-workspace' && r.source.agentWorkspaceId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.projectRootPath ? '本地项目' : 'Proma 托管项目'} · {p.name}</option>)}</select>
          <Button variant="outline" onClick={() => { const project = view.projects.find((p) => p.id === projectSelect.current?.value); if (project) patchSharing({ roots: [...sharing.roots, { id: 'ws_' + crypto.randomUUID().replaceAll('-', ''), name: project.name, source: { type: 'agent-workspace', agentWorkspaceId: project.id }, enabled: true, permissions: { read: true, write: false, shell: false }, createdAt: Date.now() }] }) }}>添加项目</Button>
          <Button variant="outline" onClick={() => { void run('picker', async () => { const root = await window.electronAPI.pickMcpShareFolder(); if (root && !sharing.roots.some((r) => r.id === root.id)) patchSharing({ roots: [...sharing.roots, root] }) }) }}>添加其他文件夹</Button>
          <Button variant="ghost" onClick={() => { void run('choices', refreshChoices) }}>刷新项目与渠道</Button>
        </div>
        <Button disabled={!view.sharingDirty || view.busy.sharing} onClick={() => { void run('sharing', saveSharing) }}>保存共享内容与能力</Button>
      </div></SettingsCard>

      <SettingsCard divided={false}><div className="p-4 space-y-3">
        <h3 className="text-sm font-semibold">② ChatGPT 可以怎么使用 PROMA</h3>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={sharing.policy.read === 'enabled'} onChange={(e) => patchSharing({ policy: { ...sharing.policy, read: e.target.checked ? 'enabled' : 'disabled' } })} />直接读取与搜索</label>
        <p className="text-xs text-muted-foreground">确定性高，不额外启动 PROMA 模型。下列工具设置同时约束远程读取能力。</p>
        <div className="flex flex-wrap gap-4 text-xs">{(['fileRead','search','git'] as const).map((key) => <label key={key}><input type="checkbox" checked={sharing.tools[key]} onChange={(e) => patchSharing({ tools: { ...sharing.tools, [key]: e.target.checked } })} /> {key === 'fileRead' ? '文件读取' : key === 'search' ? '文本搜索' : 'Git 只读'}</label>)}</div>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={sharing.delegation.enabled} onChange={(e) => patchSharing({ delegation: { ...sharing.delegation, enabled: e.target.checked } })} />允许 ChatGPT 将复杂任务交给 PROMA 分析</label>
        <p className="text-xs text-muted-foreground">可与直接工具同时开启。会使用你在 PROMA 配置的 Agent 模型，可能产生额外 API / 渠道费用；ChatGPT 订阅不包含这项费用。仅分析，不写入、不执行 Shell。</p>
        {sharing.delegation.enabled && <div className="space-y-2">
          <label className="block text-xs">Agent 渠道<select className={selectClass} value={sharing.delegation.channelId ?? ''} onChange={(e) => patchSharing({ delegation: { ...sharing.delegation, channelId: e.target.value, modelId: undefined } })}><option value="">请选择渠道</option>{view.channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="block text-xs">Agent 模型<select className={selectClass} value={sharing.delegation.modelId ?? ''} onChange={(e) => patchSharing({ delegation: { ...sharing.delegation, modelId: e.target.value } })}><option value="">请选择模型</option>{channel?.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          {!modelReady && <p className="text-xs text-destructive">PROMA Agent 尚未配置可用模型。<Button variant="link" onClick={() => setSettingsTab('channels')}>前往渠道设置</Button></p>}
          <p className="text-xs text-muted-foreground">同时最多 1 个分析任务，等待队列最多 3 个；重复请求合并。额外文件夹需先关联为 Proma 项目。</p>
        </div>}
        <div className="flex gap-4 text-xs text-muted-foreground"><label><input type="checkbox" disabled checked={false} readOnly />远程写入（等待审批能力）</label><label><input type="checkbox" disabled checked={false} readOnly />远程 Shell（等待审批能力）</label></div>
        <Button disabled={!view.sharingDirty || view.busy.sharing} onClick={() => { void run('sharing', saveSharing) }}>保存能力设置</Button>
      </div></SettingsCard>

      <SettingsCard divided={false}><div className="p-4 space-y-3">
        <h3 className="text-sm font-semibold">③ 远程连接</h3>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={remote.enabled} onChange={(e) => patchRemote({ enabled: e.target.checked })} />启用远程访问</label>
        {view.remoteDirty && <p className="text-xs text-muted-foreground">连接设置有未保存更改。当前运行：{REMOTE_PROVIDERS.find((p) => p.kind === live?.kind)?.name ?? '未启动'}。</p>}
        <fieldset className="flex flex-wrap gap-4 text-sm"><legend className="mb-2">你希望怎么连接？</legend>{([['stable','长期固定连接'],['test','快速测试'],['external','我已有公网 HTTPS'],['experimental','实验性']] as const).map(([key,label]) => <label key={key}><input type="radio" name="remote-intent" checked={intent === key} onChange={() => setIntent(key)} /> {label}</label>)}</fieldset>
        <div className="grid gap-2 sm:grid-cols-2">{REMOTE_PROVIDERS.filter((p) => p.use === intent || p.kind === remote.provider).map((p) => <label key={p.kind} className="flex items-start gap-2 rounded-lg border border-border p-3 has-[:checked]:bg-accent"><input type="radio" name="remote-provider" checked={remote.provider === p.kind} onChange={() => patchRemote({ provider: p.kind, autoStart: p.kind === 'cloudflare-quick' ? false : remote.autoStart })} /><span className="space-y-1"><span className="block text-sm font-medium">{p.name} · {p.capabilities.verification === 'verified' ? 'ChatGPT 已验证' : p.capabilities.verification === 'beta' ? 'Beta · 网页未实测' : p.capabilities.verification === 'experimental' ? '实验性' : '未实测'}</span><span className="block text-xs text-muted-foreground">账号：{p.capabilities.requiresAccount ? '需要' : '通常不需要'} · 自有域名：{p.capabilities.requiresDomain ? '需要' : '不需要'}<br />{p.use === 'external' ? '费用取决于外部服务' : p.capabilities.freeTier === 'yes' ? '免费测试' : '免费档/计划限制请查看官方说明'} · {p.capabilities.stableUrl ? '地址稳定' : '地址会变化'}</span></span></label>)}</div>
        {provider && <>
          <Button variant="link" onClick={() => { void window.electronAPI.openExternal(provider.priceUrl) }}>查看官方价格与限制</Button>
          <ol className="space-y-2">{provider.steps.map((step, index) => <li key={step.id} className="rounded border border-border/60 p-2 text-xs"><strong>{index + 1}. {step.title}</strong><p className="my-1 text-muted-foreground">{step.description}</p>{step.action?.kind === 'open-url' && step.action.url && <Button size="sm" variant="outline" onClick={() => { void window.electronAPI.openExternal(step.action!.url!) }}>打开官方页面</Button>}<span role="status">{view.guide[step.id]}</span></li>)}</ol>
          {provider.kind !== 'external-https' && <div className="flex flex-wrap gap-2"><span className="break-all text-xs text-muted-foreground">程序：{selected.executablePath ?? '从 PATH 检测'}</span><Button size="sm" variant="outline" onClick={() => setProviderSettings({ executablePath: undefined })}>使用 PATH</Button><Button size="sm" variant="outline" onClick={() => { void run('picker', async () => { const path = await window.electronAPI.pickCloudflared(); if (path) setProviderSettings({ executablePath: path }) }) }}>选择已有程序</Button><Button size="sm" variant="outline" disabled={view.busy.detect} onClick={() => { void run('detect', async () => { await saveRemote(); const found = await window.electronAPI.detectMcpProvider(); message(found.detail); setView((old) => ({ ...old, guide: { ...old.guide, binary: found.ok ? '✓ 检测完成' : '✕ 请安装或选择程序', detect: found.ok ? '✓ 设备可用' : '✕ 请检查登录状态' } })) }) }}>{view.busy.detect ? '检测中…' : '检测 / 重新检测'}</Button></div>}
          {(['cloudflare-named','ngrok','external-https'] as McpRemoteProviderKind[]).includes(provider.kind) && <label className="block text-xs">{provider.kind === 'ngrok' ? 'Assigned Development Domain（HTTPS）' : '固定 HTTPS 地址'}<Input value={selected.hostname ?? ''} placeholder="https://mcp.example.com" onChange={(e) => setProviderSettings({ hostname: e.target.value })} /></label>}
          {provider.kind === 'openai-secure' && <><label className="block text-xs">Tunnel ID<Input value={selected.tunnelId ?? ''} onChange={(e) => setProviderSettings({ tunnelId: e.target.value })} /></label><label className="block text-xs">控制面代理（可选；本机绕过）<Input value={selected.controlPlaneProxy ?? ''} onChange={(e) => setProviderSettings({ controlPlaneProxy: e.target.value })} placeholder="http://127.0.0.1:7890" /></label></>}
          {(['cloudflare-named','ngrok','openai-secure'] as McpRemoteProviderKind[]).includes(provider.kind) && <div className="space-y-2"><label className="block text-xs">{provider.kind === 'ngrok' ? 'ngrok Authtoken' : provider.kind === 'openai-secure' ? 'Runtime API Key' : 'Tunnel Token'}（{live?.tokenConfigured ? '已加密保存' : '未确认'}）<Input ref={tokenInput} type="password" autoComplete="new-password" placeholder="保存后立即清空输入" /></label><Button size="sm" variant="outline" onClick={() => { const value = tokenInput.current?.value ?? ''; if (tokenInput.current) tokenInput.current.value = ''; void run('token', async () => { await saveRemote(); await window.electronAPI.saveCloudflareToken(value, provider.kind); message('凭据已加密保存，重新连接后生效。') }) }}>保存凭据</Button></div>}
          <p className="rounded bg-muted p-2 text-xs">公网服务应转发到：<code>http://127.0.0.1:{remote.publicIngress.port}</code></p>
        </>}
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={remote.autoStart} onChange={(e) => patchRemote({ autoStart: e.target.checked })} />启动 Proma 后自动恢复远程连接</label>
        {remote.provider === 'cloudflare-quick' && <p className="text-xs text-muted-foreground">临时地址：每次重新连接可能变化，不推荐自动启动；变更后需要更新 ChatGPT App 地址。</p>}
        <div className="flex flex-wrap gap-2"><Button disabled={!view.remoteDirty || view.busy.remote} onClick={() => { void run('remote', async () => { await saveRemote(); message('已保存。内容/范围立即生效；连接参数变化需要重新连接。') }) }}>保存远程设置</Button><Button disabled={view.busy.start || !remote.enabled || !remote.provider} onClick={() => { void run('start', async () => { if (view.sharingDirty) await saveSharing(); await saveRemote(); await window.electronAPI.startMcpTransport() }) }}>{view.busy.start ? '正在连接…' : live?.restartRequired ? '立即重新连接' : connected ? '重新连接' : '启动连接'}</Button><Button variant="outline" disabled={!connected && !view.busy.start} onClick={() => { void run('stop', async () => { await window.electronAPI.stopMcpTransport() }) }}>停止远程连接</Button></div>
        {live?.restartRequired && <p role="status" className="text-xs">已保存，需要重新连接后生效。当前连接仍使用原配置。</p>}
      </div></SettingsCard>

      {live?.phase === 'ready' && <SettingsCard divided={false}><div className="p-4 space-y-3"><h3 className="text-sm font-semibold">④ 连接 ChatGPT</h3><p className="text-sm">公网 MCP 已准备好 · {live.stableUrl ? 'URL 固定' : '临时 URL'}</p>{live.endpoint?.publicUrl ? <><div className="break-all rounded bg-muted p-2 text-xs">{live.endpoint.connectorUrl}</div><ol className="list-inside list-decimal text-xs leading-relaxed"><li>复制 Server URL</li><li>打开 ChatGPT Apps，Create App</li><li>Connection 选择 Server URL</li><li>Authentication 选择 No Authentication</li><li>Scan Tools，然后测试列出项目和读取文件</li></ol><Button onClick={() => { void run('copy', async () => { await window.electronAPI.copyMcpConnectorUrl(); message('完整授权 URL 已复制，请妥善保管。') }) }}>复制 Server URL</Button></> : <p className="text-xs">实验性 OpenAI：在 ChatGPT 选择 Tunnel 连接，使用同一个 Tunnel ID。</p>}<Button variant="outline" onClick={() => { void window.electronAPI.openExternal('https://chatgpt.com') }}>打开 ChatGPT Apps</Button></div></SettingsCard>}

      <SettingsCard divided={false}><div className="p-4 space-y-2"><h3 className="text-sm font-semibold">⑤ 状态与诊断</h3><p role="status" className="break-all text-xs">{view.message}</p><p className="text-sm">连接：{live?.phase ?? 'stopped'} · {live?.probe ? `${live.probe.toolCount} 个工具` : '尚未检查'}</p>{live?.errorCode && <p role="alert" className="text-xs text-destructive">{live.errorCode} · {live.errorMessage}</p>}
        {live?.urlChanged ? <p className="text-xs">ChatGPT Server URL 已变化，旧 App 地址需要更新。<Button size="sm" variant="link" onClick={() => { void run('copy', async () => { await window.electronAPI.copyMcpConnectorUrl() }) }}>复制新 URL</Button></p> : <p className="text-xs text-muted-foreground">共享内容变更不会改变 ChatGPT 地址，无需重新配置 App。</p>}
        {view.schemaChanged || !view.schemaBaseline ? <p className="text-xs">{view.schemaChanged ? '工具定义已变化，请在 ChatGPT 点击 Refresh。' : '尚未确认 ChatGPT 工具扫描状态。'}<Button variant="link" size="sm" onClick={() => { void run('schema', async () => { await window.electronAPI.confirmMcpToolSchema() }) }}>我已 Scan Tools / Refresh</Button></p> : <p className="text-xs text-muted-foreground">工具定义未变化，无需 Refresh。</p>}
        <Button variant="outline" size="sm" disabled={view.busy.diagnose} onClick={() => { void run('diagnose', async () => { const result = await window.electronAPI.diagnoseMcpTransport(); message(result.checks.map((c) => `${c.ok ? '✓' : '⚠'} ${c.name}：${c.detail}`).join('；')) }) }}>运行无副作用检查</Button>
        {view.tasks.length > 0 && <details><summary className="text-xs">PROMA 分析任务（不导出指令）</summary>{view.tasks.toReversed().map((t) => <div key={t.id} className="mt-2 rounded border p-2 text-xs">{t.id} · {t.status}{['queued','running'].includes(t.status) && <Button size="sm" variant="ghost" onClick={() => { void run('task', async () => { await window.electronAPI.cancelMcpTask(t.id) }) }}>取消</Button>}<p>{t.summary?.slice(0, 500) ?? t.warnings.join('；')}</p></div>)}</details>}
      </div></SettingsCard>

      <SettingsCard divided={false}><details className="p-4 space-y-3"><summary className="text-sm font-semibold">⑥ 高级设置</summary>
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={sharing.localEndpoint.enabled} onChange={(e) => patchSharing({ localEndpoint: { ...sharing.localEndpoint, enabled: e.target.checked } })} />启用仅本机 MCP Endpoint（不是远程 Provider）</label>
        <label className="block text-xs">本机端口（空表示自动）<Input type="number" value={sharing.localEndpoint.port === 'auto' ? '' : sharing.localEndpoint.port} onChange={(e) => patchSharing({ localEndpoint: { ...sharing.localEndpoint, port: e.target.value ? Number(e.target.value) : 'auto' } })} /></label>
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={sharing.localEndpoint.auth === 'managed-bearer'} onChange={(e) => patchSharing({ localEndpoint: { ...sharing.localEndpoint, auth: e.target.checked ? 'managed-bearer' : 'none' } })} />本机 Endpoint 使用受管 Bearer 认证</label>
        <label className="block text-xs">远程入口固定端口<Input type="number" value={remote.publicIngress.port} onChange={(e) => patchRemote({ publicIngress: { ...remote.publicIngress, port: Number(e.target.value) } })} /></label>
        <label className="flex gap-2 text-xs"><input type="checkbox" checked={remote.publicIngress.scopeMode === 'custom'} onChange={(e) => patchRemote({ publicIngress: { ...remote.publicIngress, scopeMode: e.target.checked ? 'custom' : 'inherit' } })} />远程只共享其中一部分</label>
        {remote.publicIngress.scopeMode === 'custom' && sharing.roots.map((root) => <label key={root.id} className="flex gap-2 text-xs"><input type="checkbox" checked={remote.publicIngress.workspaceIds.includes(root.id)} onChange={(e) => patchRemote({ publicIngress: { ...remote.publicIngress, workspaceIds: e.target.checked ? [...remote.publicIngress.workspaceIds, root.id] : remote.publicIngress.workspaceIds.filter((id) => id !== root.id) } })} />{root.name}</label>)}
        <p className="break-all text-xs text-muted-foreground">入口：{live?.endpoint?.localUrl ?? '未启动'} · PID {live?.pid ?? '—'} · {live?.executableVersion ?? ''}</p>
        <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(JSON.stringify({ provider: live?.kind, phase: live?.phase, endpoint: live?.endpoint, errorCode: live?.errorCode, probe: live?.probe, requests: live?.requests, toolSchemaFingerprint: live?.toolSchemaFingerprint, connectorUrlFingerprint: live?.connectorUrlFingerprint }, null, 2)).then(() => message('已复制安全诊断，不包含任务指令或内部 Agent 日志。')) }}>复制安全诊断</Button>
        <details><summary className="text-xs">请求记录</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{live?.requests?.map((t) => `${new Date(t.at).toLocaleTimeString()} ${t.probe ? '探测' : '请求'} ${t.method} ${t.path} ${t.rpcMethod ?? '-'} HTTP ${t.status}`).join('\n') || '暂无请求'}</pre></details>
        {remote.provider === 'openai-secure' && <div className="space-x-2"><Button size="sm" variant="outline" onClick={() => { void run('doctor', async () => { const result = await window.electronAPI.runMcpTunnelDoctor(); message(result.ok ? 'Doctor 通过' : 'Doctor 有未通过项，请检查实验性配置。') }) }}>OpenAI Doctor</Button><Button size="sm" variant="outline" onClick={() => { void run('logs', async () => { await window.electronAPI.openMcpTunnelLogs() }) }}>Tunnel Logs</Button></div>}
        <details><summary className="text-xs">撤销旧 Secret URL</summary><p className="my-2 text-xs text-muted-foreground">会停止远程连接，旧 App 地址失效。正常保存和重连不会轮换 Secret。</p><Button size="sm" variant="outline" onClick={() => { void run('secret', async () => { await window.electronAPI.rotateMcpConnectorSecret(); message('Secret 已轮换，重新连接后复制新 URL。') }) }}>轮换 Secret 并停止</Button></details>
      </details></SettingsCard>
    </div>
  </SettingsSection>
}
