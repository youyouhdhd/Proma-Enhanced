/**
 * McpServerSettings - 「连接 ChatGPT Web」完整向导（第二轮 P1，规范 §16-§46）
 *
 * 信息架构：Overview → Projects（Workspace 注册表 + 独立权限）→ Local MCP →
 * OpenAI Secure Tunnel → ChatGPT Setup → Advanced（Connection Profiles）。
 * 普通用户按向导即可完成配置；专业用户在 Local MCP / Advanced 找到全部细节。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { Loader2, Play, Square, RefreshCw, TerminalSquare, FolderGit2, ShieldCheck, Globe, Plug, Stethoscope, Trash2, Plus, KeyRound, ExternalLink } from 'lucide-react'
import type { PromaMcpServerConfig, PromaMcpServerStatus, PromaMcpToolSummary, PromaMcpTunnelState, PromaMcpWorkspaceEntry, AgentWorkspace } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { cn } from '@/lib/utils'

/** 与主进程 config.ts 相同的 FNV-1a 派生（UI 侧仅用于新条目即时展示 key） */
function deriveWorkspaceIdLocal(agentWorkspaceId: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < agentWorkspaceId.length; i++) {
    hash ^= agentWorkspaceId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return 'ws_' + (hash >>> 0).toString(16).padStart(8, '0')
}

const DEFAULT_CONFIG: PromaMcpServerConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 'auto',
  workspaces: [],
  profiles: [],
  accessMode: 'read-only',
  tools: { fileRead: true, fileWrite: false, search: true, git: true, shell: false },
  auth: { type: 'none' },
}

/** 状态指示点 */
function StatusDot({ on, warn }: { on?: boolean; warn?: boolean }): React.ReactElement {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', on ? 'bg-emerald-500' : warn ? 'bg-amber-500' : 'bg-muted-foreground/40')} />
}

export function McpServerSettings(): React.ReactElement {
  const [config, setConfig] = React.useState<PromaMcpServerConfig>(DEFAULT_CONFIG)
  const [status, setStatus] = React.useState<PromaMcpServerStatus | null>(null)
  const [tools, setTools] = React.useState<PromaMcpToolSummary[]>([])
  const [workspaces, setWorkspaces] = React.useState<AgentWorkspace[]>([])
  const [tunnel, setTunnel] = React.useState<PromaMcpTunnelState | null>(null)
  const [tunnelIdInput, setTunnelIdInput] = React.useState('')
  const [runtimeKeyInput, setRuntimeKeyInput] = React.useState('')
  const [doctorOutput, setDoctorOutput] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const workspacesAtom = useAtomValue(agentWorkspacesAtom)

  React.useEffect(() => {
    if (Array.isArray(workspacesAtom) && workspacesAtom.length > 0) setWorkspaces(workspacesAtom as unknown as AgentWorkspace[])
  }, [workspacesAtom])

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const [appSettings, serverStatus, toolSummaries, tunnelState] = await Promise.all([
        window.electronAPI.getSettings(),
        window.electronAPI.getMcpServerStatus(),
        window.electronAPI.listMcpServerTools(),
        window.electronAPI.getMcpTunnelState(),
      ])
      const nextConfig = appSettings.mcpServer ?? DEFAULT_CONFIG
      setConfig(nextConfig)
      setStatus(serverStatus)
      setTools(toolSummaries)
      setTunnel(tunnelState)
      setTunnelIdInput(nextConfig.workspaces.length >= 0 ? (tunnelState?.tunnelId ?? '') : '')
    } catch (error) {
      console.error('[MCP 设置] 加载失败:', error)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    window.electronAPI.listAgentWorkspaces().then((items) => {
      setWorkspaces(items as unknown as AgentWorkspace[])
    }).catch(() => {})
  }, [refresh])

  /** 保存配置并按需启停（update-config 会持久化 + 重启/停止） */
  const applyConfig = React.useCallback(async (next: PromaMcpServerConfig): Promise<void> => {
    setBusy(true)
    try {
      const statusNow = await window.electronAPI.updateMcpServerConfig(next)
      setStatus(statusNow)
      setConfig(next)
      const toolSummaries = await window.electronAPI.listMcpServerTools()
      setTools(toolSummaries)
    } catch (error) {
      console.error('[MCP 设置] 应用配置失败:', error)
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const toggleEnabled = React.useCallback(async (): Promise<void> => {
    if (busy) return
    const next = { ...config, enabled: !config.enabled }
    await applyConfig(next)
  }, [busy, config, applyConfig])

  const enabledWorkspaces = config.workspaces.filter((w) => w.enabled)
  const running = status?.running ?? false

  const addWorkspace = (agentWorkspaceId: string): void => {
    if (!agentWorkspaceId || config.workspaces.some((w) => w.agentWorkspaceId === agentWorkspaceId)) return
    const ws = workspaces.find((w) => w.id === agentWorkspaceId)
    const entry: PromaMcpWorkspaceEntry = {
      id: deriveWorkspaceIdLocal(agentWorkspaceId),
      agentWorkspaceId,
      ...(ws?.name ? { name: ws.name } : {}),
      enabled: true,
      permissions: { read: true, write: false, shell: false },
      createdAt: Date.now(),
    }
    void applyConfig({ ...config, workspaces: [...config.workspaces, entry] })
  }

  const updateWorkspace = (id: string, patch: Partial<PromaMcpWorkspaceEntry>): void => {
    void applyConfig({
      ...config,
      workspaces: config.workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    })
  }

  const removeWorkspace = (id: string): void => {
    void applyConfig({
      ...config,
      workspaces: config.workspaces.filter((w) => w.id !== id),
      profiles: config.profiles.map((p) => ({ ...p, workspaceIds: p.workspaceIds.filter((wid) => wid !== id) })),
    })
  }

  const addProfile = (): void => {
    const id = 'p_' + Math.random().toString(36).slice(2, 8)
    void applyConfig({
      ...config,
      profiles: [...config.profiles, { id, name: 'Profile ' + (config.profiles.length + 1), workspaceIds: [], enabled: true }],
    })
  }

  const updateProfile = (profileId: string, patch: Partial<PromaMcpServerConfig['profiles'][number]>): void => {
    void applyConfig({
      ...config,
      profiles: config.profiles.map((p) => (p.id === profileId ? { ...p, ...patch } : p)),
    })
  }

  const removeProfile = (profileId: string): void => {
    void applyConfig({ ...config, profiles: config.profiles.filter((p) => p.id !== profileId) })
  }

  const saveTunnelKey = async (): Promise<void> => {
    if (!runtimeKeyInput.trim()) return
    const result = await window.electronAPI.saveMcpTunnelRuntimeKey(runtimeKeyInput)
    setRuntimeKeyInput('')
    if (result.success) {
      setTunnel(await window.electronAPI.getMcpTunnelState())
    }
  }

  return (
    <SettingsSection
      title="连接 ChatGPT Web"
      description="把 PROMA 的本地工具能力（文件 / 搜索 / Git / Shell）通过标准 MCP 暴露给 ChatGPT，让 ChatGPT 在你授权的项目里读文件、查 Git、按权限改代码。"
    >
      <div className="space-y-4">
        {/* ===== Overview ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="text-sm font-medium">让 ChatGPT Web 操作你的本地 PROMA 项目</div>
            <div className="text-xs leading-relaxed text-muted-foreground space-y-2">
              <p>PROMA 会在你的电脑上启动一个本地 MCP 服务，让 ChatGPT 可以读取你授权的项目，并在你允许时修改文件、运行命令和查看 Git。</p>
              <p>ChatGPT 无法直接访问 localhost，因此需要一个安全连接把 ChatGPT 的 MCP 请求转发到你的电脑。</p>
              <p>推荐使用 <span className="font-medium text-foreground">OpenAI Secure MCP Tunnel</span>。Tunnel 只负责安全转发请求；AI 推理仍由 ChatGPT 完成，PROMA 负责执行本地工具。</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <span className="font-mono">ChatGPT</span><span>→</span>
              <span className="font-mono">OpenAI Tunnel</span><span>→</span>
              <span className="font-mono">tunnel-client</span><span>→</span>
              <span className="font-mono text-foreground">PROMA MCP ({enabledWorkspaces.length} 个项目)</span>
            </div>
          </div>
        </SettingsCard>

        {/* ===== STEP 1 Projects ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><FolderGit2 size={14} /> 步骤 1：选择 ChatGPT 可以访问的项目</div>
            <p className="text-xs text-muted-foreground">ChatGPT 只能访问这里明确授权的项目。没有勾选的目录不会通过 MCP 暴露；每个项目可独立授予读取 / 写入 / 执行权限。</p>
            {config.workspaces.length === 0 && (
              <div className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">还没有授权任何项目。从下面的下拉框添加第一个项目。</div>
            )}
            <div className="space-y-2">
              {config.workspaces.map((entry) => {
                const agentWs = workspaces.find((w) => w.id === entry.agentWorkspaceId)
                return (
                  <div key={entry.id} className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <Switch checked={entry.enabled} onCheckedChange={(v) => updateWorkspace(entry.id, { enabled: v })} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{entry.name ?? agentWs?.name ?? entry.agentWorkspaceId}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">{entry.id}</div>
                      </div>
                      <Button variant="ghost" size="icon" className="ml-auto size-7" onClick={() => removeWorkspace(entry.id)} aria-label="移除项目">
                        <Trash2 size={13} />
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-4 text-xs">
                      {([['read', '读取'], ['write', '写入'], ['shell', '执行命令']] as const).map(([perm, label]) => (
                        <label key={perm} className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={entry.permissions[perm]}
                            onChange={(e) => updateWorkspace(entry.id, { permissions: { ...entry.permissions, [perm]: e.target.checked } })}
                            className="size-3.5 accent-[var(--primary)]"
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                      {!agentWs && <span className="ml-auto text-[10px] text-amber-600">关联的 PROMA 工作区已不存在</span>}
                    </div>
                  </div>
                )
              })}
            </div>
            <Select value="" onValueChange={addWorkspace}>
              <SelectTrigger className="h-9"><SelectValue placeholder="+ 添加要共享的 PROMA 项目" /></SelectTrigger>
              <SelectContent>
                {workspaces
                  .filter((ws) => !config.workspaces.some((entry) => entry.agentWorkspaceId === ws.id))
                  .map((ws) => (<SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>))}
              </SelectContent>
            </Select>
            {enabledWorkspaces.length > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600"><ShieldCheck size={12} /> {enabledWorkspaces.length} 个项目已授权</div>
            )}
          </div>
        </SettingsCard>

        {/* ===== STEP 2 Local MCP ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><TerminalSquare size={14} /> 步骤 2：启动本地 PROMA MCP</div>
            <div className="flex items-center gap-2">
              <StatusDot on={running} />
              <span className="text-sm">{running ? '本地服务运行正常' : '本地服务未运行'}</span>
              {busy && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
              <div className="ml-auto flex gap-2">
                {!running ? (
                  <Button size="sm" type="button" disabled={busy || enabledWorkspaces.length === 0} onClick={() => void toggleEnabled()}>
                    <Play size={14} /> 启动
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" type="button" disabled={busy} onClick={() => void toggleEnabled()}>
                    <Square size={14} /> 停止
                  </Button>
                )}
                <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => void refresh()}>
                  <RefreshCw size={14} /> 刷新
                </Button>
              </div>
            </div>
            {running && status && (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs space-y-1 text-muted-foreground">
                <div>地址：<span className="font-mono text-foreground">{status.endpoint}</span></div>
                <div>已开放：{status.workspaces.filter((w) => w.enabled).length} 个项目 · {tools.filter((t) => t.enabled).length} 个工具 · 活跃会话 {status.activeSessions}</div>
              </div>
            )}
            {status?.errorMessage && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive break-all">{status.errorMessage}</div>
            )}
            <p className="text-[11px] text-muted-foreground/80">这个 localhost 地址主要供本机和 Tunnel 使用，不能直接粘贴到 ChatGPT Web。</p>
            {/* 高级：端口 / 认证 / 工具组 */}
            <details className="rounded-md border border-border/60 px-3 py-2 text-xs">
              <summary className="cursor-pointer select-none text-muted-foreground">高级设置（端口 / 认证 / 工具组）</summary>
              <div className="mt-3 space-y-3">
                <div className="grid gap-2 md:grid-cols-[140px_1fr] md:items-center">
                  <div className="text-muted-foreground">监听端口</div>
                  <Select
                    value={String(config.port)}
                    onValueChange={(value) => void applyConfig({ ...config, port: value === 'auto' ? 'auto' : Number(value) })}
                  >
                    <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">自动选择</SelectItem>
                      {[8787, 8899, 3210].map((port) => (<SelectItem key={port} value={String(port)}>{port}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2 md:grid-cols-[140px_1fr] md:items-center">
                  <div className="text-muted-foreground">访问认证</div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={config.auth.type}
                      onValueChange={(value) => void applyConfig({ ...config, auth: value === 'bearer' ? { type: 'bearer', token: config.auth.token ?? '' } : { type: 'none' } })}
                    >
                      <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">无认证</SelectItem>
                        <SelectItem value="bearer">Bearer Token</SelectItem>
                      </SelectContent>
                    </Select>
                    {config.auth.type === 'bearer' && (
                      <Input
                        value={config.auth.token ?? ''}
                        onChange={(e) => setConfig({ ...config, auth: { type: 'bearer', token: e.target.value } })}
                        onBlur={() => void applyConfig(config)}
                        placeholder="Bearer Token"
                        className="h-8 flex-1 font-mono text-xs"
                      />
                    )}
                  </div>
                </div>
                <div className="grid gap-2 md:grid-cols-[140px_1fr] md:items-center">
                  <div className="text-muted-foreground">全局访问模式</div>
                  <Select
                    value={config.accessMode}
                    onValueChange={(value) => void applyConfig({ ...config, accessMode: value as PromaMcpServerConfig['accessMode'] })}
                  >
                    <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="read-only">只读（推荐）</SelectItem>
                      <SelectItem value="full">完整（含写入 / Shell）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {config.accessMode === 'full' && (
                  <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                    <div className="text-[11px] font-medium text-amber-700 dark:text-amber-300">高风险能力（仍受每个项目独立权限约束）</div>
                    <div className="flex items-center justify-between">
                      <span>允许写入 / 编辑文件</span>
                      <Switch checked={config.tools.fileWrite} onCheckedChange={(v) => void applyConfig({ ...config, tools: { ...config.tools, fileWrite: v } })} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span>允许 Shell 执行</span>
                      <Switch checked={config.tools.shell} onCheckedChange={(v) => void applyConfig({ ...config, tools: { ...config.tools, shell: v } })} />
                    </div>
                  </div>
                )}
                <div className="space-y-1">
                  <div className="text-muted-foreground">工具（{tools.filter((t) => t.enabled).length}/{tools.length} 启用）</div>
                  {tools.map((tool) => (
                    <div key={tool.name} className="flex items-center gap-2">
                      <StatusDot on={tool.enabled} />
                      <span className={cn('font-mono', tool.enabled ? 'text-foreground' : 'text-muted-foreground/50')}>{tool.name}</span>
                      <span className="text-muted-foreground/60">{tool.risk === 'read' ? '只读' : tool.risk === 'write' ? '写入' : '执行'}</span>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          </div>
        </SettingsCard>

        {/* ===== STEP 3 Tunnel ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><Globe size={14} /> 步骤 3：建立 OpenAI Secure MCP Tunnel</div>
            <div className="rounded-md bg-muted/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              <div className="mb-1 font-medium text-foreground">分工</div>
              PROMA 启动本地 MCP → 你在 OpenAI Platform 创建 Tunnel 并拿到 Tunnel ID + Runtime API Key → PROMA 在本机运行 tunnel-client 连接 OpenAI → 你在 ChatGPT 创建 MCP App 并选择该 Tunnel。tunnel-client 只向 OpenAI 发起出站 HTTPS，不需要开放公网端口。
            </div>
            <div className="grid gap-2 md:grid-cols-[140px_1fr] md:items-center">
              <div className="text-xs text-muted-foreground">Tunnel ID</div>
              <Input
                value={tunnelIdInput}
                onChange={(e) => setTunnelIdInput(e.target.value)}
                onBlur={() => {
                  void window.electronAPI.getMcpTunnelState()
                  // tunnelId 持久化走 settings；这里直接写（与主进程 saveConfig 等价的最小路径）
                  void (async () => {
                    const settings = await window.electronAPI.getSettings()
                    await window.electronAPI.updateSettings({ mcpTunnel: { ...settings.mcpTunnel, tunnelId: tunnelIdInput.trim() || undefined } })
                    setTunnel(await window.electronAPI.getMcpTunnelState())
                  })()
                }}
                placeholder="tunnel_xxxxxxxxx"
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="grid gap-2 md:grid-cols-[140px_1fr] md:items-center">
              <div className="text-xs text-muted-foreground">Runtime API Key</div>
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  value={runtimeKeyInput}
                  onChange={(e) => setRuntimeKeyInput(e.target.value)}
                  placeholder={tunnel?.status === 'running' || tunnel === null ? '已保存（输入可覆盖）' : '尚未保存'}
                  className="h-8 flex-1 font-mono text-xs"
                  autoComplete="new-password"
                />
                <Button size="sm" variant="outline" type="button" className="h-8" disabled={!runtimeKeyInput.trim()} onClick={() => void saveTunnelKey()}>
                  <KeyRound size={13} /> 保存
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <StatusDot on={tunnel?.status === 'running'} warn={tunnel?.status === 'starting'} />
              <span>{tunnel?.status === 'running' ? 'OpenAI Tunnel 已连接' : tunnel?.status === 'starting' ? '正在建立连接…' : tunnel?.status === 'error' ? (tunnel.message ?? 'Tunnel 异常') : '未连接'}</span>
              <div className="ml-auto flex gap-2">
                {tunnel?.status !== 'running' ? (
                  <Button size="sm" type="button" className="h-7" onClick={() => { void window.electronAPI.startMcpTunnel().then((s) => setTunnel(s)) }}>
                    <Plug size={13} /> 启动安全连接
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" type="button" className="h-7" onClick={() => { void window.electronAPI.stopMcpTunnel().then((s) => setTunnel(s)) }}>
                    <Square size={13} /> 停止
                  </Button>
                )}
                <Button size="sm" variant="ghost" type="button" className="h-7" onClick={() => { void window.electronAPI.runMcpTunnelDoctor().then((r) => setDoctorOutput((r.ok ? '[OK] ' : '[异常] ') + r.output)) }}>
                  <Stethoscope size={13} /> 运行诊断
                </Button>
              </div>
            </div>
            {doctorOutput && <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-[10px] whitespace-pre-wrap break-all">{doctorOutput}</pre>}
            <p className="text-[11px] text-muted-foreground/80">Runtime API Key 经系统凭据加密保存，不写入配置文件或命令行；tunnel-client 未安装时请先按 OpenAI 文档安装，或在需要时指定完整路径（见 ChatGPT Setup 步骤 3 的说明）。</p>
          </div>
        </SettingsCard>

        {/* ===== STEP 4 ChatGPT Setup ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><ExternalLink size={14} /> 步骤 4：在 ChatGPT 中添加 PROMA</div>
            <ol className="space-y-1.5 text-xs text-muted-foreground list-decimal list-inside">
              <li>打开 ChatGPT 设置</li>
              <li>Settings → Security and login</li>
              <li>开启 Developer mode</li>
              <li>打开 Plugins</li>
              <li>点击「+」创建 Developer Mode App</li>
              <li>Connection 选择 Tunnel</li>
              <li>选择刚刚创建的 Tunnel</li>
              <li>创建 PROMA App</li>
            </ol>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" type="button" className="h-7" onClick={() => void window.electronAPI.openExternal('https://platform.openai.com/docs/developers')}>
                打开 OpenAI Platform 文档
              </Button>
              {tunnel?.tunnelId && (
                <Button size="sm" variant="ghost" type="button" className="h-7" onClick={() => { void navigator.clipboard.writeText(tunnel.tunnelId ?? '') }}>
                  复制 Tunnel ID
                </Button>
              )}
            </div>
          </div>
        </SettingsCard>

        {/* ===== STEP 5 使用 ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-2">
            <div className="text-sm font-medium">步骤 5：在 ChatGPT 对话中使用 PROMA</div>
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>示例：「使用 PROMA 查看我本地有哪些项目」→ ChatGPT 调用 workspace_list</p>
              <p>「在两个项目里搜索 refreshToken」→ 跨仓库 search_text</p>
              <p>「检查这两个项目的 Git 修改」→ git_status_batch / git_diff</p>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-emerald-600"><ShieldCheck size={12} /> 成功标志：ChatGPT 调用了 workspace_list / read_file / git_status 等工具</div>
            <p className="text-[11px] text-muted-foreground/70">ChatGPT 实际允许的工具权限取决于你的套餐、Workspace 设置和当前功能开放情况。PROMA 会按照 ChatGPT 实际授予的能力工作。</p>
          </div>
        </SettingsCard>

        {/* ===== Advanced：Connection Profiles ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">高级：Connection Profiles</div>
              <Button size="sm" variant="outline" type="button" className="h-7" onClick={addProfile}><Plus size={13} /> 新建 Profile</Button>
            </div>
            <p className="text-xs text-muted-foreground">需要按工作 / 个人 / 客户强隔离时，用 Profile 把不同项目分组到不同 endpoint（如 /mcp/work），每个 Profile 可绑定不同 ChatGPT App 或 Tunnel。</p>
            {config.profiles.length === 0 && <div className="text-xs text-muted-foreground/70">暂无 Profile（大多数用户不需要；默认 /mcp 已暴露全部已启用项目）。</div>}
            <div className="space-y-2">
              {config.profiles.map((profile) => (
                <div key={profile.id} className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <Switch checked={profile.enabled} onCheckedChange={(v) => updateProfile(profile.id, { enabled: v })} />
                    <Input
                      value={profile.name}
                      onChange={(e) => updateProfile(profile.id, { name: e.target.value })}
                      className="h-7 w-44 text-xs"
                    />
                    <code className="text-[10px] text-muted-foreground">/mcp/{profile.id}</code>
                    <Button variant="ghost" size="icon" className="ml-auto size-7" onClick={() => removeProfile(profile.id)} aria-label="删除 Profile">
                      <Trash2 size={13} />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {config.workspaces.map((ws) => {
                      const checked = profile.workspaceIds.includes(ws.id)
                      return (
                        <label key={ws.id} className="flex items-center gap-1.5 text-xs">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => updateProfile(profile.id, { workspaceIds: e.target.checked ? [...profile.workspaceIds, ws.id] : profile.workspaceIds.filter((id) => id !== ws.id) })}
                            className="size-3.5 accent-[var(--primary)]"
                          />
                          <span>{ws.name ?? ws.agentWorkspaceId}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
            {running && status && status.profileEndpoints.length > 0 && (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
                {status.profileEndpoints.map((p) => (
                  <div key={p.id}>{p.name}：<span className="font-mono text-foreground">{p.endpoint}</span></div>
                ))}
              </div>
            )}
          </div>
        </SettingsCard>
      </div>
    </SettingsSection>
  )
}
