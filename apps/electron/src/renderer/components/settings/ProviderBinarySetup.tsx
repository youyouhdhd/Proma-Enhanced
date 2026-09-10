import * as React from 'react'
import { atom, useAtom } from 'jotai'
import type { ProviderDefinition, ProviderBinaryDetection, RemoteProviderSettings } from '@proma/shared'
import { Button } from '@/components/ui/button'

const detectionAtom = atom<Record<string, ProviderBinaryDetection>>({})
interface Props {
  provider: ProviderDefinition; value: RemoteProviderSettings; busy: boolean
  onChange(value: Partial<RemoteProviderSettings>): void
  detect(): Promise<ProviderBinaryDetection>
  run(key: string, action: () => Promise<void>): Promise<void>
}
export function ProviderBinarySetup({ provider, value, busy, onChange, detect, run }: Props): React.ReactElement | null {
  const [results, setResults] = useAtom(detectionAtom)
  const binary = provider.controls.binary
  const key = provider.kind + ':' + (value.executablePath ?? 'PATH')
  const found = results[key]
  React.useEffect(() => {
    let active = true
    void window.electronAPI.detectMcpProvider({ provider: provider.kind, executablePath: value.executablePath }).then((result) => {
      if (active) setResults((old) => ({ ...old, [key]: result }))
    }).catch(() => { if (active) setResults((old) => ({ ...old, [key]: { ok: false, detail: '检测失败，请重新检测。' } })) })
    return () => { active = false }
  }, [key, provider.kind, value.executablePath, setResults])
  if (!binary) return null
  return <section className="space-y-2 rounded border border-border p-3" aria-label={binary.displayName + '程序设置'}>
    <p role="status" className="text-sm">{found?.ok ? `✓ ${binary.displayName} 已安装` : found ? `未检测到有效的 ${binary.displayName}` : `检测 ${binary.displayName} 程序`}</p>
    <p className="break-all text-xs text-muted-foreground">{found?.version}{found?.ok ? ` · 来源：${found.source === 'custom' ? '自定义程序' : '系统 PATH'}` : `PROMA 需要 ${binary.displayName} 建立此连接。安装后重新检测；PATH 检测成功无需手动选择。`}</p>
    {found && !found.ok && <p role="alert" className="text-xs text-destructive">{found.detail}</p>}
    <div className="flex flex-wrap gap-2">
      {!found?.ok && binary.downloadUrl && <Button size="sm" variant="outline" onClick={() => { void window.electronAPI.openExternal(binary.downloadUrl!) }}>打开 {binary.displayName} 官方下载页</Button>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run('detect', async () => { const result = await detect(); setResults((old) => ({ ...old, [key]: result })) }) }}>{busy ? '检测中…' : found?.ok ? '重新检测' : '我已安装，检测程序'}</Button>
    </div>
    <details className="space-y-2"><summary className="text-xs">高级：手动选择 {binary.expectedFiles[0]}</summary><p className="break-all text-xs text-muted-foreground">{value.executablePath ?? '使用系统 PATH'}{found?.resolvedPath && ` → ${found.resolvedPath}`}</p>
      <Button size="sm" variant="outline" onClick={() => onChange({ executablePath: undefined })}>使用 PATH</Button>
      <Button size="sm" variant="outline" onClick={() => { void run('picker', async () => { const path = await window.electronAPI.pickMcpProviderExecutable(provider.kind); if (path) onChange({ executablePath: path }) }) }}>选择 {binary.expectedFiles[0]}</Button>
    </details>
  </section>
}
