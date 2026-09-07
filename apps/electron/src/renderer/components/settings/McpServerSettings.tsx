/**
 * McpServerSettings - 「连接 ChatGPT Web」向导（第三轮强化）
 *
 * 三平台分工：PROMA（项目 + 本地连接）→ OpenAI Platform（Tunnel + Key）→ ChatGPT Web（MCP App）。
 * OpenAI Tunnel Client 由 PROMA 自动管理（也支持本机已有程序 / 系统 PATH）。
 * Tunnel 生命周期状态经 mcp-tunnel:state-changed 实时推送，readiness 以 /readyz 为准。
 */

import * as React from 'react'
import { Loader2, Play, Square, RefreshCw, TerminalSquare, FolderGit2, ShieldCheck, Globe, Plug, Stethoscope, Trash2, Plus, KeyRound, ExternalLink, Download, FolderOpen } from 'lucide-react'
import type { PromaMcpServerConfig, PromaMcpServerStatus, PromaMcpToolSummary, PromaMcpTunnelState, PromaMcpWorkspaceEntry, PromaMcpTunnelDoctorResult, PromaMcpTunnelDetection, PromaMcpTunnelClientMode, AgentWorkspace } from '@proma/shared'
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

function StatusDot({ on, warn }: { on?: boolean; warn?: boolean }): React.ReactElement {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', on ? 'bg-emerald-500' : warn ? 'bg-amber-500' : 'bg-muted-foreground/40')} />
}

/** Tunnel 生命周期阶段的用户可读文案（规范 §21/§60） */
function tunnelPhaseLabel(state: PromaMcpTunnelState | null): { text: string; tone: 'ok' | 'warn' | 'idle' | 'error' } {
  if (!state) return { text: '加载中…', tone: 'idle' }
  switch (state.phase) {
    case 'connected': return { text: '✓ 已连接到 OpenAI Secure MCP Tunnel', tone: 'ok' }
    case 'starting': return { text: '正在启动 OpenAI Tunnel Client…', tone: 'warn' }
    case 'waiting-ready': return { text: '正在等待安全连接准备完成…', tone: 'warn' }
    case 'preflight': return { text: '正在检查配置…', tone: 'warn' }
    case 'stopping': return { text: '正在停止…', tone: 'warn' }
    case 'not-installed': return { text: 'OpenAI Tunnel Client 尚未安装', tone: 'idle' }
    case 'needs-config': return { text: '配置未完成（Tunnel ID / Runtime API Key / 本地 MCP）', tone: 'idle' }
    case 'error': return { text: state.error?.title ?? '连接异常', tone: 'error' }
    default: return { text: '未连接', tone: 'idle' }
  }
}

const MODE_OPTIONS: Array<{ mode: PromaMcpTunnelClientMode; label: string; hint: string }> = [
  { mode: 'managed', label: '由 PROMA 自动管理（推荐）', hint: 'PROMA 负责下载、更新和运行官方组件，全程无需终端。' },
  { mode: 'custom-path', label: '使用本机已有程序', hint: '指定本机已有的 tunnel-client 可执行文件，PROMA 负责运行。' },
  { mode: 'system-path', label: '从系统 PATH 查找（高级）', hint: '使用已加入系统 PATH 的 tunnel-client 命令。' },
]

export function McpServerSettings(): React.ReactElement {
  const [config, setConfig] = React.useState<PromaMcpServerConfig>(DEFAULT_CONFIG)
  const [status, setStatus] = React.useState<PromaMcpServerStatus | null>(null)
  const [tools, setTools] = React.useState<PromaMcpToolSummary[]>([])
  const [workspaces, setWorkspaces] = React.useState<AgentWorkspace[]>([])
  const [tunnel, setTunnel] = React.useState<PromaMcpTunnelState | null>(null)
  const [tunnelMode, setTunnelMode] = React.useState<PromaMcpTunnelClientMode>('managed')
  const [tunnelIdInput, setTunnelIdInput] = React.useState('')
  const [runtimeKeyInput, setRuntimeKeyInput] = React.useState('')
  const [customPathInput, setCustomPathInput] = React.useState('')
  const [detection, setDetection] = React.useState<PromaMcpTunnelDetection | null>(null)
  const [doctor, setDoctor] = React.useState<PromaMcpTunnelDoctorResult | null>(null)
  const [autoConnect, setAutoConnect] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

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
      setTunnelMode(appSettings.mcpTunnel?.mode ?? 'managed')
      setTunnelIdInput(appSettings.mcpTunnel?.tunnelId ?? tunnelState?.tunnelId ?? '')
      setCustomPathInput(appSettings.mcpTunnel?.executablePath ?? '')
      setAutoConnect(appSettings.mcpTunnel?.autoConnect === true)
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

  // Tunnel 生命周期状态实时推送（规范 §22）：不再依赖手动刷新
  React.useEffect(() => {
    return window.electronAPI.onMcpTunnelStateChanged((state) => setTunnel(state))
  }, [])

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
    await applyConfig({ ...config, enabled: !config.enabled })
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
    void applyConfig({ ...config, workspaces: config.workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w)) })
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
    void applyConfig({ ...config, profiles: [...config.profiles, { id, name: 'Profile ' + (config.profiles.length + 1), workspaceIds: [], enabled: true }] })
  }

  const updateProfile = (profileId: string, patch: Partial<PromaMcpServerConfig['profiles'][number]>): void => {
    void applyConfig({ ...config, profiles: config.profiles.map((p) => (p.id === profileId ? { ...p, ...patch } : p)) })
  }

  const removeProfile = (profileId: string): void => {
    void applyConfig({ ...config, profiles: config.profiles.filter((p) => p.id !== profileId) })
  }

  const saveTunnelMode = async (mode: PromaMcpTunnelClientMode, executablePath?: string): Promise<void> => {
    setTunnelMode(mode)
    const stateNow = await window.electronAPI.saveMcpTunnelConfig({ mode, ...(mode === 'custom-path' && executablePath !== undefined ? { executablePath } : {}) })
    setTunnel(stateNow)
    setDetection(await window.electronAPI.detectMcpTunnelClient())
  }

  const pickAndSaveExecutable = async (): Promise<void> => {
    const picked = await window.electronAPI.pickMcpTunnelExecutable()
    if (picked.canceled || !picked.path) return
    setCustomPathInput(picked.path)
    await saveTunnelMode('custom-path', picked.path)
  }

  const detectClient = async (): Promise<void> => {
    setDetection(await window.electronAPI.detectMcpTunnelClient())
  }

  const installClient = async (): Promise<void> => {
    setDetection(null)
    const result = await window.electronAPI.installMcpTunnelClient()
    setDetection(result)
    setTunnel(await window.electronAPI.getMcpTunnelState())
  }

  const saveTunnelId = async (): Promise<void> => {
    const stateNow = await window.electronAPI.saveMcpTunnelConfig({ tunnelId: tunnelIdInput })
    setTunnel(stateNow)
  }

  const saveTunnelKey = async (): Promise<void> => {
    if (!runtimeKeyInput.trim()) return
    const result = await window.electronAPI.saveMcpTunnelRuntimeKey(runtimeKeyInput)
    setRuntimeKeyInput('')
    if (result.success) {
      setTunnel(await window.electronAPI.getMcpTunnelState())
    } else {
      console.error('[MCP 设置] 保存 Runtime API Key 失败:', result.message)
    }
  }

  const toggleAutoConnect = async (value: boolean): Promise<void> => {
    setAutoConnect(value)
    await window.electronAPI.saveMcpTunnelConfig({ autoConnect: value })
  }

  const connect = async (): Promise<void> => {
    setDoctor(null)
    await window.electronAPI.startMcpTunnel()
  }

  const phase = tunnelPhaseLabel(tunnel)
  const clientInfo = tunnel?.client
  const lastTool = status?.lastToolCall

  return (
    <SettingsSection
      title="连接 ChatGPT Web"
      description="把 PROMA 的本地工具能力（文件 / 搜索 / Git / Shell）通过标准 MCP 暴露给 ChatGPT，让 ChatGPT 在你授权的项目里读文件、查 Git、按权限改代码。"
    >
      <div className="space-y-4">
        {/* ===== 三平台分工 + 复制关系 ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="text-sm font-medium">让 ChatGPT Web 操作你的本地 PROMA 项目</div>
            <div className="text-xs leading-relaxed text-muted-foreground">这次配置会在 3 个地方完成：① PROMA——选择允许 ChatGPT 使用的本地项目，并运行本地连接组件；② OpenAI Platform——创建 Secure MCP Tunnel 和 Runtime API Key；③ ChatGPT Web——创建 PROMA MCP App，并选择刚才的 Tunnel。</div>
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <span className="font-mono">ChatGPT</span><span>→</span>
              <span className="font-mono">OpenAI Secure MCP Tunnel</span><span>→</span>
              <span className="font-mono">OpenAI Tunnel Client（这台电脑）</span><span>→</span>
              <span className="font-mono text-foreground">PROMA Local MCP</span><span>→</span>
              <span className="font-mono">你授权的本地项目</span>
            </div>
            <div className="overflow-x-auto rounded-md border border-border/60">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr><th className="px-3 py-1.5 text-left font-medium">获取位置</th><th className="px-3 py-1.5 text-left font-medium">获取内容</th><th className="px-3 py-1.5 text-left font-medium">粘贴到</th></tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  <tr><td className="px-3 py-1.5">OpenAI Platform / Tunnels</td><td className="px-3 py-1.5">Tunnel ID</td><td className="px-3 py-1.5">PROMA / 步骤 4</td></tr>
                  <tr><td className="px-3 py-1.5">OpenAI Platform / Runtime API Keys</td><td className="px-3 py-1.5">Runtime API Key</td><td className="px-3 py-1.5">PROMA / 步骤 5</td></tr>
                  <tr><td className="px-3 py-1.5">PROMA</td><td className="px-3 py-1.5">Local MCP URL</td><td className="px-3 py-1.5 text-emerald-600">无需复制，PROMA 自动交给 Tunnel Client</td></tr>
                  <tr><td className="px-3 py-1.5">ChatGPT</td><td className="px-3 py-1.5">Tunnel Connection</td><td className="px-3 py-1.5">选择同一个 Tunnel</td></tr>
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground/80">不要把 PROMA 的 localhost MCP URL 复制进 ChatGPT；不要把 Runtime API Key 复制进 ChatGPT。</p>
          </div>
        </SettingsCard>

        {/* ===== STEP 1 项目 ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><FolderGit2 size={14} /> 步骤 1 · PROMA：选择 ChatGPT 可以访问的本地项目</div>
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
              <div className="flex items-center gap-1.5 text-xs text-emerald-600"><ShieldCheck size={12} /> ✓ 已授权 {enabledWorkspaces.length} 个项目</div>
            )}
          </div>
        </SettingsCard>

        {/* ===== STEP 2 Local MCP ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><TerminalSquare size={14} /> 步骤 2 · PROMA：启动本地 PROMA MCP</div>
            <div className="flex items-center gap-2">
              <StatusDot on={running} />
              <span className="text-sm">{running ? '✓ PROMA 本地 MCP 已运行' : '本地服务未运行'}</span>
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
                <div className="text-emerald-600/90">这个地址不需要复制。PROMA 会自动把它交给 OpenAI Tunnel Client。</div>
                <div>已开放：{status.workspaces.filter((w) => w.enabled).length} 个项目 · {tools.filter((t) => t.enabled).length} 个工具 · 活跃会话 {status.activeSessions}</div>
                {lastTool && <div className="text-emerald-600">✓ 已收到来自 ChatGPT 的 MCP 请求 · 最近工具：{lastTool.name} · {new Date(lastTool.at).toLocaleTimeString()}</div>}
              </div>
            )}
            {status?.errorMessage && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive break-all">{status.errorMessage}</div>
            )}
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

        {/* ===== STEP 3 OpenAI Tunnel Client ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><Globe size={14} /> 步骤 3 · 这台电脑：准备 OpenAI Tunnel Client</div>
            <div className="text-xs leading-relaxed text-muted-foreground">OpenAI Tunnel Client 是 OpenAI 官方提供的本地安全连接组件，运行在这台电脑上（程序名称 <span className="font-mono">tunnel-client{process.platform === 'win32' ? '.exe' : ''}</span>）。PROMA 会负责启动它：它建立从这台电脑主动连接到 OpenAI 的安全 HTTPS 连接，把 ChatGPT 发来的 MCP 请求转交给 PROMA 的本地 MCP。它不是 AI 模型，也不是 MCP Server，不需要你访问任何网络地址，也不需要打开终端。</div>
            <div className="space-y-2">
              {MODE_OPTIONS.map((option) => (
                <label key={option.mode} className="flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 cursor-pointer hover:bg-muted/40">
                  <input
                    type="radio"
                    name="tunnel-client-mode"
                    checked={tunnelMode === option.mode}
                    onChange={() => void saveTunnelMode(option.mode)}
                    className="mt-1 accent-[var(--primary)]"
                  />
                  <div>
                    <div className="text-xs font-medium">{option.label}</div>
                    <div className="text-[11px] text-muted-foreground">{option.hint}</div>
                  </div>
                </label>
              ))}
            </div>
            {tunnelMode === 'managed' && (
              <div className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
                {clientInfo?.installed ? (
                  <div className="flex items-center gap-2 text-xs text-emerald-600">
                    <ShieldCheck size={13} />
                    <span>✓ OpenAI Tunnel Client 已就绪{clientInfo.version ? ' · 版本 ' + clientInfo.version : ''}{clientInfo.path ? ' · 位置 ' + clientInfo.path : ''}</span>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">尚未安装。这是连接 ChatGPT Web 所需的 OpenAI 官方本地连接组件。</span>
                    <Button size="sm" type="button" className="h-7" disabled={tunnel?.phase === 'preflight'} onClick={() => void installClient()}>
                      <Download size={13} /> 安装官方组件
                    </Button>
                  </div>
                )}
                {detection && !detection.installed && detection.errorMessage && (
                  <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">{detection.errorMessage}</div>
                )}
              </div>
            )}
            {tunnelMode === 'custom-path' && (
              <div className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
                <div className="text-xs text-muted-foreground">程序位置（本地可执行文件，如 C:\Tools\tunnel-client.exe；不接受下载网址）</div>
                <div className="flex items-center gap-2">
                  <Input
                    value={customPathInput}
                    onChange={(e) => setCustomPathInput(e.target.value)}
                    placeholder="C:\Tools\tunnel-client.exe"
                    className="h-8 flex-1 font-mono text-xs"
                  />
                  <Button size="sm" variant="outline" type="button" className="h-8" onClick={() => void pickAndSaveExecutable()}>
                    <FolderOpen size={13} /> 选择文件
                  </Button>
                  <Button size="sm" variant="outline" type="button" className="h-8" disabled={!customPathInput.trim()} onClick={() => void saveTunnelMode('custom-path', customPathInput)}>
                    检测程序
                  </Button>
                </div>
                {detection?.installed && (
                  <div className="text-xs text-emerald-600">✓ 程序可以运行{detection.version ? ' · 版本 ' + detection.version : ''}{detection.path ? ' · 位置 ' + detection.path : ''}</div>
                )}
                {detection && !detection.installed && detection.errorMessage && (
                  <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">{detection.errorMessage}</div>
                )}
              </div>
            )}
            {tunnelMode === 'system-path' && (
              <div className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
                <div className="text-xs text-muted-foreground">PROMA 将从系统 PATH 中查找 tunnel-client 命令。</div>
                <Button size="sm" variant="outline" type="button" className="h-7" onClick={() => void detectClient()}>检测程序</Button>
                {detection?.installed && <div className="text-xs text-emerald-600">✓ 已找到{detection.version ? ' · 版本 ' + detection.version : ''}{detection.path ? ' · 位置 ' + detection.path : ''}</div>}
                {detection && !detection.installed && detection.errorMessage && (
                  <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">{detection.errorMessage}</div>
                )}
              </div>
            )}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={autoConnect} onCheckedChange={(v) => void toggleAutoConnect(v)} />
              <span>PROMA 启动后自动恢复 ChatGPT 安全连接（默认关闭；开启后 PROMA 启动会自动连接 Tunnel）</span>
            </label>
          </div>
        </SettingsCard>

        {/* ===== STEP 4 Tunnel ID ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><ExternalLink size={14} /> 步骤 4 · OpenAI Platform：创建 Tunnel 并填写 Tunnel ID</div>
            <div className="text-xs leading-relaxed text-muted-foreground">① 打开 OpenAI Platform，选择正确的 Organization / Workspace；② 创建 Secure MCP Tunnel；③ 找到 Tunnel ID（形如 tunnel_…）；④ 复制后回到 PROMA 粘贴到下面。</div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" type="button" className="h-7" onClick={() => void window.electronAPI.openExternal('https://platform.openai.com')}>
                打开 OpenAI Platform
              </Button>
            </div>
            <div className="grid gap-2 md:grid-cols-[140px_1fr] md:items-center">
              <div className="text-xs text-muted-foreground">Tunnel ID</div>
              <Input
                value={tunnelIdInput}
                onChange={(e) => setTunnelIdInput(e.target.value)}
                onBlur={() => void saveTunnelId()}
                placeholder="tunnel_xxxxxxxxx"
                className="h-8 font-mono text-xs"
              />
            </div>
          </div>
        </SettingsCard>

        {/* ===== STEP 5 Runtime API Key ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><KeyRound size={14} /> 步骤 5 · OpenAI Platform：创建 Runtime API Key</div>
            <div className="text-xs leading-relaxed text-muted-foreground">Runtime API Key 用来证明这台电脑上的 OpenAI Tunnel Client 有权使用刚创建的 Tunnel。① 创建 Runtime API Key；② 为 Tunnel 配置需要的权限；③ 复制 Key；④ 回到 PROMA 粘贴。Key 只保存在这台电脑（系统凭据加密），不会进入 ChatGPT。</div>
            <div className="grid gap-2 md:grid-cols-[140px_1fr] md:items-center">
              <div className="text-xs text-muted-foreground">Runtime API Key</div>
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  value={runtimeKeyInput}
                  onChange={(e) => setRuntimeKeyInput(e.target.value)}
                  placeholder={tunnel?.runtimeKeyConfigured ? '已安全保存（输入可覆盖）' : '尚未保存'}
                  className="h-8 flex-1 font-mono text-xs"
                  autoComplete="new-password"
                />
                <Button size="sm" variant="outline" type="button" className="h-8" disabled={!runtimeKeyInput.trim()} onClick={() => void saveTunnelKey()}>
                  安全保存
                </Button>
              </div>
            </div>
            {tunnel?.runtimeKeyConfigured && <div className="text-xs text-emerald-600">✓ Runtime API Key 已安全保存</div>}
          </div>
        </SettingsCard>

        {/* ===== STEP 6 检查配置并连接 ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium"><Plug size={14} /> 步骤 6 · PROMA：检查配置并连接</div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusDot on={phase.tone === 'ok'} warn={phase.tone === 'warn'} />
              <span className={cn('text-sm', phase.tone === 'error' ? 'text-destructive' : phase.tone === 'ok' ? 'text-emerald-600' : 'text-foreground')}>{phase.text}</span>
              {tunnel?.pid && <span className="text-[11px] text-muted-foreground">PID {tunnel.pid}</span>}
              <div className="ml-auto flex gap-2">
                {tunnel?.phase !== 'connected' && tunnel?.phase !== 'starting' && tunnel?.phase !== 'waiting-ready' && tunnel?.phase !== 'preflight' ? (
                  <Button size="sm" type="button" className="h-7" onClick={() => void connect()}>
                    <Plug size={13} /> 检查配置并连接 ChatGPT
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" type="button" className="h-7" onClick={() => { void window.electronAPI.stopMcpTunnel().then((s) => setTunnel(s)) }}>
                    <Square size={13} /> 停止
                  </Button>
                )}
                <Button size="sm" variant="ghost" type="button" className="h-7" onClick={() => { void window.electronAPI.runMcpTunnelDoctor().then((r) => setDoctor(r)) }}>
                  <Stethoscope size={13} /> 运行诊断
                </Button>
              </div>
            </div>
            {tunnel?.error && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive space-y-1">
                <div>{tunnel.error.title}</div>
                {tunnel.error.action && <div className="text-destructive/80">下一步：{tunnel.error.action}</div>}
              </div>
            )}
            {doctor && (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs space-y-1.5">
                <div className="font-medium">连接诊断</div>
                {doctor.checks.map((check) => (
                  <div key={check.name} className="flex items-center gap-2">
                    <StatusDot on={check.ok} />
                    <span className={check.ok ? 'text-foreground' : 'text-destructive'}>{check.name}</span>
                    {check.message && <span className="text-muted-foreground">{check.message}</span>}
                  </div>
                ))}
                <details>
                  <summary className="cursor-pointer select-none text-muted-foreground">查看技术详情</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 px-2 py-1 font-mono text-[10px]">{doctor.technical ? ('exit: ' + (doctor.technical.exitCode ?? '-') + '\n' + (doctor.technical.stdout || '') + '\n' + (doctor.technical.stderr || '')) : '（无）'}</pre>
                </details>
              </div>
            )}
          </div>
        </SettingsCard>

        {/* ===== STEP 7 ChatGPT Web ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium"><ExternalLink size={14} /> 步骤 7 · ChatGPT Web：创建 PROMA App</div>
            <ol className="space-y-1 text-xs text-muted-foreground list-decimal list-inside">
              <li>打开 ChatGPT 的 Apps / Connectors 设置</li>
              <li>如 Workspace 要求，开启 Developer Mode</li>
              <li>创建自定义 MCP App</li>
              <li>Connection 选择：Tunnel</li>
              <li>选择步骤 4 创建的 Tunnel</li>
              <li>等待 ChatGPT 扫描 MCP Tools</li>
              <li>保存 PROMA App</li>
            </ol>
            <p className="text-[11px] text-muted-foreground/80">这里不需要填写：localhost MCP URL、Runtime API Key、Codex 登录凭据。</p>
            <Button size="sm" variant="outline" type="button" className="h-7" onClick={() => void window.electronAPI.openExternal('https://chatgpt.com')}>
              打开 ChatGPT
            </Button>
          </div>
        </SettingsCard>

        {/* ===== STEP 8 第一次测试 ===== */}
        <SettingsCard divided={false}>
          <div className="px-4 py-4 space-y-2">
            <div className="text-sm font-medium">步骤 8 · 第一次测试</div>
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>在 ChatGPT 对话里发送（可点击复制）：</p>
            </div>
            <div className="space-y-1.5">
              <Button size="sm" variant="outline" type="button" className="h-7" onClick={() => { void navigator.clipboard.writeText('使用 PROMA 列出我当前允许 ChatGPT 访问的所有本地项目。') }}>
                复制测试提示词 1
              </Button>
              <Button size="sm" variant="ghost" type="button" className="h-7" onClick={() => { void navigator.clipboard.writeText('使用 PROMA 查看项目的 Git 状态。') }}>
                复制测试提示词 2
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">预期：ChatGPT 调用 workspace_list 返回项目列表；随后 git_status 返回状态。</div>
            {lastTool && <div className="flex items-center gap-1.5 text-xs text-emerald-600"><ShieldCheck size={12} /> ✓ 已收到来自 ChatGPT 的 MCP 请求（最近工具：{lastTool.name}）</div>}
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
