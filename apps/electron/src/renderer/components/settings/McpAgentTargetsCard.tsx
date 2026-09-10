import * as React from 'react'
import type { Channel, McpDelegationConfig, McpAgentTarget } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingHelp } from './SettingHelp'

interface Props { value: McpDelegationConfig; channels: Array<Pick<Channel, 'id' | 'name' | 'models'>>; onChange(value: McpDelegationConfig): void }
export function McpAgentTargetsCard({ value, channels, onChange }: Props): React.ReactElement {
  const available = channels.flatMap((channel) => channel.models.map((model, index) => ({ id: value.targets.find((target) => target.channelId === channel.id && target.modelId === model.id)?.id ?? 'target_' + crypto.randomUUID().replaceAll('-', ''), channelId: channel.id, modelId: model.id, enabled: true, priority: index })))
  const select = (targets: McpAgentTarget[], checked: boolean) => {
    const kept = value.targets.filter((target) => !targets.some((candidate) => candidate.channelId === target.channelId && candidate.modelId === target.modelId))
    onChange({ ...value, targets: [...kept, ...(checked ? targets : [])].map((target, priority) => ({ ...target, priority })) })
  }
  return <section className="space-y-3 rounded-lg border border-border p-3">
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} />允许 ChatGPT 交给 PROMA Agent 分析</label>
    <p className="text-xs text-muted-foreground">只读分析会使用所选渠道额度；不写入、不执行 Shell。直接工具不会调用模型。</p>
    {value.enabled && <>
      <label className="block text-sm">模型策略<SettingHelp title="Agent 策略">默认 Fallback：失败后尝试下一个可用模型。轮询按任务分配模型；Manual 要求工具传 target_id。目标变更不影响公网 URL。Parallel 暂未提供。</SettingHelp><select className="w-full rounded border border-input bg-background p-2" value={value.strategy} onChange={(event) => onChange({ ...value, strategy: event.target.value as McpDelegationConfig['strategy'] })}><option value="fallback">Fallback · 按优先级尝试</option><option value="round-robin">Round Robin · 轮询</option><option value="manual">Manual · 显式选择</option></select></label>
      <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => select(available, true)}>全选可用模型</Button><Button size="sm" variant="outline" onClick={() => onChange({ ...value, targets: [] })}>清空</Button></div>
      {!available.length && <p className="text-sm text-muted-foreground">尚无启用的渠道模型，请先在渠道设置中配置。</p>}
      {channels.map((channel) => <fieldset key={channel.id} className="space-y-2 rounded border border-border p-2"><legend className="px-1 text-sm">{channel.name}</legend><Button size="sm" variant="ghost" onClick={() => select(available.filter((target) => target.channelId === channel.id), true)}>选择该渠道全部模型</Button>{channel.models.map((model) => {
        const target = available.find((candidate) => candidate.channelId === channel.id && candidate.modelId === model.id)!
        const selected = value.targets.find((candidate) => candidate.channelId === channel.id && candidate.modelId === model.id && candidate.enabled)
        return <label key={model.id} className="block text-sm"><input type="checkbox" checked={Boolean(selected)} onChange={(event) => select([target], event.target.checked)} /> {model.name ?? model.id}{selected && value.strategy === 'manual' && <code className="ml-2 break-all text-xs">{selected.id}</code>}</label>
      })}</fieldset>)}
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">并发任务<SettingHelp title="Agent 并发">默认 1，最多 4。提高并发可能同时消耗多个模型额度，仅影响分析队列，不重连网络。</SettingHelp><Input type="number" min={1} max={4} value={value.maxConcurrent} onChange={(event) => onChange({ ...value, maxConcurrent: Number(event.target.value) })} /></label><label className="text-sm">等待队列<Input type="number" min={1} max={20} value={value.maxQueued} onChange={(event) => onChange({ ...value, maxQueued: Number(event.target.value) })} /></label></div>
      <p className="text-xs text-muted-foreground">已选 {value.targets.filter((target) => target.enabled).length} 个目标。保存时检查授权，至少一个可用目标即可；其余不可用目标不阻塞 Fallback。</p>
    </>}
  </section>
}
