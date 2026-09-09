import * as React from 'react'
import { atom, useAtom } from 'jotai'
import type { McpTransportKind, McpTransportStatus, PromaRemoteAccessConfig, PromaMcpWorkspaceEntry, McpTransportDiagnostic } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'

const configAtom = atom<PromaRemoteAccessConfig | null>(null)
const statusAtom = atom<McpTransportStatus | null>(null)
const messageAtom = atom('')
const busyAtom = atom(false)
const scopeAtom = atom<PromaMcpWorkspaceEntry[]>([])
const diagnosisAtom = atom<McpTransportDiagnostic | null>(null)
const choices: Array<{ kind: McpTransportKind; name: string; detail: string }> = [
  { kind: 'cloudflare-named', name: 'Cloudflare Named · 日常推荐', detail: '稳定 HTTPS 域名，重启后可复用同一 ChatGPT App。' },
  { kind: 'cloudflare-quick', name: 'Cloudflare Quick · 快速测试', detail: '无需域名；每次启动生成新 URL，只适合临时测试。' },
  { kind: 'openai-secure', name: 'OpenAI Secure Tunnel · 实验性', detail: 'Hosted 工具扫描存在已知风险；扫描停滞时建议切换 Public HTTPS。' },
  { kind: 'local', name: 'Local Only · 仅本机', detail: '供本机 MCP Client 使用，不启动公网连接。' },
]

export function RemoteAccessSettings(): React.ReactElement {
  const [config, setConfig] = useAtom(configAtom)
  const [status, setStatus] = useAtom(statusAtom)
  const [message, setMessage] = useAtom(messageAtom)
  const [busy, setBusy] = useAtom(busyAtom)
  const [workspaces, setWorkspaces] = useAtom(scopeAtom)
  const [diagnosis, setDiagnosis] = useAtom(diagnosisAtom)
  // 密码是瞬时表单输入，不进入 React/Jotai 配置或持久状态，提交后立即清空。
  const tokenInput = React.useRef<HTMLInputElement>(null)
  const refresh = async () => {
    const snapshot = await window.electronAPI.getMcpTransport()
    setStatus(snapshot.status); setConfig((current) => current ?? snapshot.config)
  }
  const refreshScopes = async () => {
    const [settings, agents] = await Promise.all([window.electronAPI.getSettings(), window.electronAPI.listAgentWorkspaces()])
    setWorkspaces((settings.mcpServer?.workspaces ?? []).map((w) => ({ ...w, name: w.name ?? agents.find((a) => a.id === w.agentWorkspaceId)?.name ?? w.agentWorkspaceId })))
  }
  React.useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { if (!disposed) await refresh() } catch { if (!disposed) setMessage('远程连接后台不可用，请完全重启 Proma。') }
      if (!disposed) timer = setTimeout(() => { void poll() }, 1500)
    }
    void poll(); void refreshScopes().catch(() => undefined)
    return () => { disposed = true; clearTimeout(timer) }
  }, [])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage(''); setDiagnosis(null)
    try { await action(); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失败') }
    finally { setBusy(false) }
  }
  if (!config) return <SettingsSection title="远程 MCP" description="正在读取连接设置…"><p role="status">{message}</p></SettingsSection>
  const running = status && ['starting', 'preflight', 'ready'].includes(status.phase)
  const cloudflare = config.mode.startsWith('cloudflare')
  const patch = (next: Partial<PromaRemoteAccessConfig>) => setConfig({ ...config, ...next })
  return <SettingsSection title="远程 MCP" description="选择连接方式。Public HTTPS 固定为只读，只开放你单独勾选的项目。">
    <div className="space-y-4">
      <SettingsCard divided={false}><div className="p-4 space-y-3">
        <fieldset disabled={busy || Boolean(running)} className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium">远程连接方式</legend>
          {choices.map((choice) => <label key={choice.kind} className="flex cursor-pointer gap-2 rounded-lg border border-border p-3 has-[:checked]:bg-accent">
            <input type="radio" name="mcp-transport" checked={config.mode === choice.kind} onChange={() => patch({ mode: choice.kind })} />
            <span><span className="block text-sm font-medium">{choice.name}</span><span className="text-xs text-muted-foreground">{choice.detail}</span></span>
          </label>)}
        </fieldset>
        {cloudflare && <fieldset disabled={busy || Boolean(running)} className="space-y-3">
          <legend className="text-sm font-medium">Public HTTPS 配置</legend>
          <p className="text-xs text-muted-foreground">准备官方 cloudflared 后从 PATH 检测或选择已有程序；Proma 不自动下载安装。</p>
          <Button size="sm" variant="ghost" onClick={() => { void window.electronAPI.openExternal('https://github.com/cloudflare/cloudflared/releases').catch(() => setMessage('请手动打开 Cloudflare 官方 Releases 页面。')) }}>打开官方 cloudflared 下载页</Button>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => patch({ cloudflare: { ...config.cloudflare, executableMode: 'system-path', customPath: undefined } })}>使用 PATH</Button>
            <Button variant="outline" onClick={() => { void run(async () => { const path = await window.electronAPI.pickCloudflared(); if (path) patch({ cloudflare: { ...config.cloudflare, executableMode: 'custom-path', customPath: path } }) }) }}>选择 cloudflared 程序</Button>
            <span className="break-all text-xs text-muted-foreground">{config.cloudflare.executableMode === 'system-path' ? 'cloudflared（PATH）' : config.cloudflare.customPath ?? '尚未选择'}</span>
          </div>
          <label className="block text-xs">Public Ingress 固定端口
            <Input type="number" min={1024} max={65535} value={config.publicIngress.port} onChange={(e) => patch({ publicIngress: { ...config.publicIngress, port: Number(e.target.value) } })} />
          </label>
          {config.mode === 'cloudflare-named' && <>
            <label className="block text-xs">稳定 HTTPS 域名
              <Input placeholder="https://mcp.example.com" value={config.cloudflare.hostname ?? ''} onChange={(e) => patch({ cloudflare: { ...config.cloudflare, hostname: e.target.value } })} />
            </label>
            <p className="text-xs text-muted-foreground">在 Cloudflare 创建 remotely-managed Tunnel，将 Published Application 指向 <code>http://127.0.0.1:{config.publicIngress.port}</code>。端口冲突会明确报错，不会自动换端口。</p>
            <label className="block text-xs">Cloudflare Tunnel Token（{status?.tokenConfigured === undefined ? '保存连接配置后检查' : status.tokenConfigured ? '已加密保存' : '尚未保存'}）
              <Input ref={tokenInput} type="password" autoComplete="new-password" placeholder="粘贴 Tunnel Token，保存后清空" />
            </label>
            <Button variant="outline" onClick={() => { const token = tokenInput.current?.value ?? ''; if (tokenInput.current) tokenInput.current.value = ''; void run(async () => { await window.electronAPI.saveCloudflareToken(token); setMessage('Token 已交给系统加密存储。') }) }}>保存 Token</Button>
          </>}
          <div className="space-y-2">
            <div className="flex items-center gap-2"><span className="text-sm font-medium">公网只读项目（单独授权）</span><Button size="sm" variant="ghost" onClick={() => { void run(refreshScopes) }}>刷新项目列表</Button></div>
            {workspaces.length === 0 && <p className="text-xs text-muted-foreground">先在下方“本机 MCP 与项目管理”添加项目，再刷新列表。不会默认公开所有项目。</p>}
            {workspaces.map((workspace) => <label key={workspace.id} className="flex items-center gap-2 text-xs">
              <input type="checkbox" disabled={!workspace.enabled || !workspace.permissions.read} checked={config.publicIngress.workspaceIds.includes(workspace.id)} onChange={(e) => patch({ publicIngress: { ...config.publicIngress, workspaceIds: e.target.checked ? [...config.publicIngress.workspaceIds, workspace.id] : config.publicIngress.workspaceIds.filter((id) => id !== workspace.id) } })} />
              {workspace.name ?? workspace.agentWorkspaceId}{!workspace.enabled || !workspace.permissions.read ? '（请先启用本机读取授权）' : ''}
            </label>)}
            <p className="text-xs text-muted-foreground">公网固定 10 个只读工具；内部项目即使允许写入，也不会公开写文件、编辑文件或 Shell。</p>
          </div>
        </fieldset>}
        {config.mode === 'openai-secure' && <fieldset disabled={busy || Boolean(running)} className="space-y-2">
          <p className="text-xs text-muted-foreground">在下方实验性设置中选择 full tunnel-client，填写 Tunnel ID 和 Runtime Key。若 Discovery 成功但不继续 tools/list，请切换 Public HTTPS。</p>
          <label className="block text-xs">Control Plane HTTP Proxy（可选，不含账号密码）<Input placeholder="http://127.0.0.1:7890" value={config.openai.controlPlaneProxy ?? ''} onChange={(e) => patch({ openai: { controlPlaneProxy: e.target.value } })} /></label>
          <p className="text-xs text-muted-foreground">仅用于 OpenAI Control Plane；本地 MCP 绕过代理。</p>
        </fieldset>}
        <label className="flex gap-2 text-xs"><input type="checkbox" disabled={busy || Boolean(running)} checked={config.autoStart} onChange={(e) => patch({ autoStart: e.target.checked })} />启动 Proma 时恢复所选连接方式及已勾选项目</label>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || Boolean(running)} onClick={() => { void run(async () => { setConfig(await window.electronAPI.saveMcpTransport(config)); setMessage('配置已保存。') }) }}>保存配置</Button>
          <Button disabled={busy || Boolean(running)} onClick={() => { void run(async () => { setConfig(await window.electronAPI.saveMcpTransport(config)); setStatus(await window.electronAPI.startMcpTransport()) }) }}>{busy ? '处理中…' : '启动连接'}</Button>
          <Button variant="outline" disabled={!running} onClick={() => { void run(async () => { setStatus(await window.electronAPI.stopMcpTransport()) }) }}>停止</Button>
          <Button variant="outline" disabled={busy} onClick={() => { void run(async () => { setDiagnosis(await window.electronAPI.diagnoseMcpTransport()) }) }}>运行连通性检查</Button>
        </div>
        <p role="status" aria-live="polite" className="break-all text-xs">{message}</p>
      </div></SettingsCard>
      <SettingsCard divided={false}><div className="p-4 space-y-2 text-xs">
        <div className="text-sm font-medium">连接状态：{status?.phase ?? 'stopped'}</div>
        <div>Local MCP / Ingress：{status?.endpoint?.localUrl ?? '未启动'}</div>
        {cloudflare && <div>cloudflared：{status?.executableVersion ?? '启动时检测版本'}</div>}
        {cloudflare && <><div>Public HTTPS：{status?.endpoint?.publicUrl ?? '未就绪'}</div><div className="break-all">ChatGPT Server URL：{status?.endpoint?.connectorUrl ?? '待生成（仅显示脱敏地址）'}</div>
          <div>Public MCP Probe：{status?.probe?.modern ? `Modern · ${status.probe.toolCount} 个只读工具 · workspace_list 成功` : '尚未验证'}</div>
          <Button disabled={busy || status?.phase !== 'ready' || !status.kind.startsWith('cloudflare')} onClick={() => { void run(async () => { await window.electronAPI.copyMcpConnectorUrl(); setMessage('完整 Server URL 已由主进程复制，请粘贴到 ChatGPT；该 URL 具有读取授权。') }) }}>复制 ChatGPT Server URL</Button>
          <p className="text-muted-foreground">ChatGPT 选择 Server URL 和 No Authentication，粘贴后 Scan Tools。Quick URL 每次变化；Named 的域名与 Secret 保持不变。工具有更新时请在 ChatGPT Refresh。</p>
          <p className="text-muted-foreground">ChatGPT 扫描和调用：请在网页中人工确认；Public Probe 成功不代表 App 已创建。</p>
        </>}
        {(status?.errorCode || diagnosis?.status.errorCode) && <p role="alert" className="text-destructive">{diagnosis?.status.errorCode ?? status?.errorCode} · {diagnosis?.status.errorMessage ?? status?.errorMessage}</p>}
        <Button variant="ghost" onClick={() => { void window.electronAPI.openExternal('https://chatgpt.com/#settings/Connectors').catch(() => setMessage('无法打开 ChatGPT，请手动打开 Apps 设置。')) }}>打开 ChatGPT Apps</Button>
        <Button variant="ghost" onClick={() => { void navigator.clipboard.writeText(JSON.stringify({ kind: status?.kind, phase: status?.phase, endpoint: status?.endpoint, errorCode: status?.errorCode, probe: status?.probe, requests: status?.requests }, null, 2)).then(() => setMessage('已复制脱敏诊断。')).catch(() => setMessage('无法写入剪贴板。')) }}>复制脱敏诊断</Button>
        {diagnosis?.checks.map((check) => <div key={check.name}>{check.ok ? '通过' : '未通过'} · {check.name} · {check.detail}</div>)}
        <details><summary>Public 请求记录（地址已脱敏，不保存参数）</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{status?.requests?.map((t) => `${new Date(t.at).toLocaleTimeString()} ${t.probe ? '官方探测' : '外部请求（来源未确认）'} ${t.method} ${t.path} ${t.rpcMethod ?? '-'} HTTP ${t.status}`).join('\n') || '暂无请求'}</pre></details>
        <details><summary>高级：撤销旧 Secret URL</summary><p className="my-2 text-muted-foreground">轮换会停止连接并使旧 URL 失效，需要在 ChatGPT 更新 Server URL。</p><Button variant="outline" disabled={busy} onClick={() => { void run(async () => { await window.electronAPI.rotateMcpConnectorSecret(); setMessage('Secret 已轮换，请重新启动并复制新 URL。') }) }}>轮换 Secret 并停止连接</Button></details>
      </div></SettingsCard>
    </div>
  </SettingsSection>
}
