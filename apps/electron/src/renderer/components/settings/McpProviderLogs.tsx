import * as React from 'react'
import { atom, useAtom } from 'jotai'
import type { ProviderLogEntry } from '@proma/shared'
import { Button } from '@/components/ui/button'
const filterAtom = atom('all')
export function McpProviderLogs({ logs, run }: { logs: ProviderLogEntry[]; run(key: string, action: () => Promise<void>): Promise<void> }): React.ReactElement {
  const [filter, setFilter] = useAtom(filterAtom)
  const entries = logs.filter((entry) => filter === 'all' || entry.source === filter)
  const text = entries.map((entry) => `${new Date(entry.at).toLocaleTimeString()} ${entry.provider} ${entry.source} ${entry.level} ${entry.text}`).join('\n')
  return <details className="rounded border border-border p-3"><summary className="text-sm font-medium">Provider 日志（已脱敏）</summary><div className="my-3 flex flex-wrap gap-2"><select aria-label="日志来源" className="rounded border border-input bg-background p-2 text-sm" value={filter} onChange={(event) => setFilter(event.target.value)}>{['all', 'system', 'command', 'stdout', 'stderr', 'probe', 'mcp'].map((source) => <option key={source} value={source}>{source}</option>)}</select><Button size="sm" variant="outline" onClick={() => { void run('copy-logs', async () => { await navigator.clipboard.writeText(text) }) }}>复制日志</Button><Button size="sm" variant="ghost" onClick={() => { void run('clear-logs', async () => { await window.electronAPI.clearMcpProviderLogs() }) }}>清空</Button></div><pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{text || '暂无日志'}</pre></details>
}
