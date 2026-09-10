import * as React from 'react'
import type { McpSharingConfig } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { SettingHelp } from './SettingHelp'

export function McpCapabilitiesCard({ value, onChange }: { value: McpSharingConfig; onChange(patch: Partial<McpSharingConfig>): void }): React.ReactElement {
  return <section className="space-y-3">
    <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => onChange({ policy: { read: 'direct', write: 'disabled', execute: 'disabled' } })}>安全读取</Button><Button size="sm" variant="outline" onClick={() => onChange({ policy: { read: 'direct', write: 'direct', execute: 'direct' }, tools: { ...value.tools, fileWrite: true, shell: true } })}>完整能力</Button><SettingHelp title="工具预设">默认安全读取；完整能力开启 Direct 写入与 Shell，仍要求每个项目分别授权。更改工具定义后需在 ChatGPT Refresh。</SettingHelp></div>
    {(['read', 'write', 'execute'] as const).map((risk) => <label key={risk} className="block text-sm">{risk === 'read' ? '读取' : risk === 'write' ? '写入' : 'Shell'}<SettingHelp title={risk === 'execute' ? 'Direct Shell' : risk === 'write' ? 'Direct Write' : '直接读取'}>{risk === 'read' ? '默认开启，读取文件与搜索，不调用模型。' : risk === 'write' ? '默认关闭。Direct 允许持有 Connector 凭据的 Client 修改已授权项目文件。' : '默认关闭。Direct 允许持有 Connector 凭据的 Client 执行命令；工作目录校验不等于操作系统沙箱。'} 项目权限和工具组开关同时生效。可随时关闭或紧急撤销访问。</SettingHelp><select className="w-full rounded border border-input bg-background p-2" value={value.policy[risk]} onChange={(event) => onChange({ policy: { ...value.policy, [risk]: event.target.value }, ...(risk !== 'read' ? { tools: { ...value.tools, [risk === 'write' ? 'fileWrite' : 'shell']: event.target.value === 'direct' } } : {}) })}><option value="disabled">Disabled</option><option value="direct">Direct</option>{risk !== 'read' && <option value="approval" disabled>Approval · 尚未开放，保存此策略将拒绝执行</option>}</select></label>)}
    <div className="flex flex-wrap gap-4 text-sm">{(['fileRead', 'search', 'git'] as const).map((key) => <label key={key}><input type="checkbox" checked={value.tools[key]} onChange={(event) => onChange({ tools: { ...value.tools, [key]: event.target.checked } })} />{key === 'fileRead' ? '文件读取' : key === 'search' ? '搜索' : 'Git 只读'}</label>)}</div>
  </section>
}
