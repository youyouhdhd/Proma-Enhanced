import * as React from 'react'
import type { RemoteProviderSettings } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { SettingHelp } from './SettingHelp'

interface Props { value: RemoteProviderSettings; onChange(value: Partial<RemoteProviderSettings>): void; run(key: string, action: () => Promise<void>): Promise<void> }
export function McpNgrokSettings({ value, onChange, run }: Props): React.ReactElement {
  const selectClass = 'w-full rounded border border-input bg-background p-2 text-sm'
  return <div className="space-y-3">
    <label className="block text-sm">认证来源<SettingHelp title="ngrok 认证">默认复用系统配置，不重复输入 Token。选择 PROMA 管理后，凭据加密存储并通过进程环境传递；更改后需要重连。</SettingHelp><select className={selectClass} value={value.authSource ?? 'system-config'} onChange={(event) => onChange({ authSource: event.target.value as RemoteProviderSettings['authSource'] })}><option value="system-config">系统 ngrok 配置</option><option value="proma-secret">PROMA 加密管理 Authtoken</option></select></label>
    <label className="block text-sm">配置文件<SettingHelp title="ngrok 配置">默认由 ngrok 查找系统配置。已有多套配置时选择自定义 YAML；配置不会复制或显示其中的 Token，修改需重连。</SettingHelp><select className={selectClass} value={value.configSource ?? 'default'} onChange={(event) => onChange({ configSource: event.target.value as RemoteProviderSettings['configSource'] })}><option value="default">系统默认</option><option value="custom">自定义 ngrok.yml</option></select></label>
    {value.configSource === 'custom' && <div className="space-y-2"><p className="break-all text-xs">{value.configPath ?? '尚未选择配置文件'}</p><Button size="sm" variant="outline" onClick={() => { void run('config-picker', async () => { const path = await window.electronAPI.pickMcpProviderConfig(); if (path) onChange({ configPath: path }) }) }}>选择配置文件</Button></div>}
    <label className="block text-sm">域名模式<SettingHelp title="ngrok 域名">固定模式使用账号分配的域名，重启后继续复用；临时模式从进程输出识别地址，重启可能变化。更改域名需要更新 ChatGPT 地址。</SettingHelp><select className={selectClass} value={value.endpointMode ?? 'fixed-domain'} onChange={(event) => onChange({ endpointMode: event.target.value as RemoteProviderSettings['endpointMode'] })}><option value="fixed-domain">固定 Assigned Domain</option><option value="auto-domain">自动临时地址</option></select></label>
    {value.endpointMode === 'auto-domain' && <p className="text-xs text-muted-foreground">临时地址，重启可能变化；长期使用请选择固定域名。</p>}
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={value.webInspector !== 'disabled'} onChange={(event) => onChange({ webInspector: event.target.checked ? 'default' : 'disabled' })} />允许 ngrok 请求 Inspector</label>
    <p className="text-xs text-muted-foreground">Inspector 可能保留请求头与内容，请仅在可信本机使用。默认沿用 ngrok 本机管理界面设置。</p>
  </div>
}
