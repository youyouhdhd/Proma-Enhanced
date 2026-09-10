import * as React from 'react'
import type { RemoteProviderSettings, McpTransportStatus } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingField } from './SettingField'
import { SettingHelp } from './SettingHelp'

interface Props { value: RemoteProviderSettings; status?: McpTransportStatus; onChange(value: Partial<RemoteProviderSettings>): void; run(key: string, action: () => Promise<void>): Promise<void> }
export function McpNgrokSettings({ value, status, onChange, run }: Props): React.ReactElement {
  const selectClass = 'w-full rounded border border-input bg-background p-2 text-sm'
  const mode = value.mode ?? (value.authSource === 'system-config' ? 'system' : 'proma-managed')
  return <div className="space-y-3">
    <SettingField label="运行方式" helpTopic="ngrok-managed-profile"><select className={selectClass} value={mode} onChange={(event) => { const mode = event.target.value as RemoteProviderSettings['mode']; onChange({ mode, authSource: mode === 'proma-managed' ? 'proma-secret' : 'system-config', credentialMode: mode === 'proma-managed' ? 'proma-secret' : 'system-config', domainConfirmed: false }) }}><option value="proma-managed">PROMA 独立环境（推荐）</option><option value="system">使用系统 ngrok</option><option value="external-existing">使用已经运行的 ngrok</option></select></SettingField>
    {mode === 'proma-managed' && <p className="text-xs text-muted-foreground">独立配置 + 加密 Credential + 专用公网地址。新 Token 不会自动创建 Domain 或消除同 Domain 冲突。<SettingHelp topic="ngrok-credential" /></p>}
    {mode === 'system' && <p className="text-xs text-muted-foreground">使用系统 ngrok 认证。适合没有其它长期 Endpoint 的环境；只执行配置自检，不读取或显示 Token。</p>}
    {mode === 'external-existing' && <p className="text-xs text-muted-foreground">PROMA 不启动程序，也不管理外部认证。请将现有 ngrok 转发到高级设置中的本机入口，完整 MCP 检查通过后即可连接。</p>}
    {mode !== 'external-existing' && <SettingField label="公网地址模式" helpTopic="ngrok-domain"><select className={selectClass} value={value.endpointMode ?? 'fixed-domain'} onChange={(event) => onChange({ endpointMode: event.target.value as RemoteProviderSettings['endpointMode'] })}><option value="fixed-domain">固定专用 Domain</option><option value="auto-domain">自动临时地址（重连可能变化）</option></select></SettingField>}
    {(mode === 'external-existing' || value.endpointMode !== 'auto-domain') && <>
      <SettingField label={mode === 'external-existing' ? '已有 Public HTTPS Origin' : 'PROMA 专用公网地址'} helpTopic="ngrok-domain"><Input value={value.hostname ?? ''} placeholder="https://proma-example.ngrok.app" onChange={(event) => onChange({ hostname: event.target.value, domainConfirmed: false })} /></SettingField>
      <Button size="sm" variant="outline" onClick={() => { void window.electronAPI.openExternal('https://dashboard.ngrok.com/domains') }}>打开 ngrok Dashboard</Button>
      {mode !== 'external-existing' && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={value.domainConfirmed === true} onChange={(event) => onChange({ domainConfirmed: event.target.checked })} />我已确认当前 Domain 专供 PROMA 使用；旧 Domain 不会自动认定为独占。</label>}
    </>}
    {value.endpointMode === 'auto-domain' && mode !== 'external-existing' && <p className="text-xs text-muted-foreground">临时地址重启可能变化；长期连接 ChatGPT 请选择固定域名。</p>}
    {status && status.phase !== 'stopped' && <section aria-label="ngrok 连接检查" className="rounded border border-border p-3">
      <h4 className="mb-2 text-sm font-medium">连接检查</h4>
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div><dt className="text-muted-foreground">配置</dt><dd>{status.ngrok?.ownership === 'existing-proma-endpoint' ? '已有 Endpoint · 外部管理' : status.ngrok?.config?.valid ? '✓ ' + (status.ngrok.config.source === 'proma-managed' ? 'PROMA 独立配置' : 'ngrok 配置有效') : '等待验证'}</dd></div>
        <div><dt className="text-muted-foreground">认证</dt><dd>{status.ngrok?.credentialSource === 'external' ? '由外部 ngrok 管理' : status.ngrok?.credentialSource === 'proma-secret' ? status.tokenConfigured ? '✓ PROMA Credential 已保存' : '需要保存 Credential' : '使用系统 ngrok 认证'}</dd></div>
        <div><dt className="text-muted-foreground">Endpoint</dt><dd>{status.ngrok?.ownership === 'external-conflict' ? '✕ 地址由其它服务占用' : status.phase === 'ready' ? '✓ 已连接当前 PROMA' : '正在检查所有权与公网连接'}</dd></div>
        <div><dt className="text-muted-foreground">公网 MCP</dt><dd>{status.probe?.modern && status.probe.workspaceList ? `✓ Modern MCP · ${status.probe.toolCount} Tools · workspace_list` : '等待完整协议验证'}</dd></div>
      </dl>
    </section>}
    <details className="space-y-2"><summary className="text-sm">ngrok 高级设置与身份诊断</summary>
      {mode === 'system' && <><SettingField label="配置文件"><select className={selectClass} value={value.configSource ?? 'default'} onChange={(event) => onChange({ configSource: event.target.value as RemoteProviderSettings['configSource'] })}><option value="default">系统默认</option><option value="custom">自定义 ngrok.yml</option></select></SettingField>{value.configSource === 'custom' && <><p className="break-all text-xs">{value.configPath ?? '尚未选择配置文件'}</p><Button size="sm" variant="outline" onClick={() => { void run('config-picker', async () => { const path = await window.electronAPI.pickMcpProviderConfig(); if (path) onChange({ configPath: path }) }) }}>选择配置文件</Button></>}</>}
      {mode !== 'external-existing' && <label className="flex gap-2 text-xs"><input type="checkbox" checked={value.webInspector !== 'disabled'} onChange={(event) => onChange({ webInspector: event.target.checked ? 'default' : 'disabled' })} />允许请求 Inspector<SettingHelp topic="ngrok-inspector" /></label>}
      <p className="break-all text-xs">配置：{status?.ngrok?.config?.path ?? (mode === 'proma-managed' ? 'PROMA 独立配置，启动时生成' : '外部 / 系统管理')}<br />Credential：{status?.ngrok?.credentialSource ?? mode}<br />Endpoint ownership：{status?.ngrok?.ownership ?? 'none'}<br />PROMA PID：{status?.pid ?? '无受管进程'}</p>
      {status?.ngrok?.inspectorUrl && <Button size="sm" variant="link" onClick={() => { void window.electronAPI.openExternal(status.ngrok!.inspectorUrl!) }}>打开 Inspector：{status.ngrok.inspectorUrl}</Button>}
    </details>
    {status?.ngrok?.ownership === 'existing-proma-endpoint' && <p role="status" className="text-sm">✓ 已有 Endpoint 已连接到当前 PROMA；PROMA 不管理该外部进程。</p>}
  </div>
}
