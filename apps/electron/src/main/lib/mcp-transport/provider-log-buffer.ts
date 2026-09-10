import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import type { McpRemoteProviderKind, ProviderLogEntry } from '@proma/shared'

/** 先脱敏后入缓冲；从不保存原始输出。 */
export function redactProviderText(text: string, secrets: readonly string[] = []): string {
  let safe = text
  for (const secret of secrets.filter(Boolean).toSorted((a, b) => b.length - a.length)) safe = safe.split(secret).join('<redacted>')
  return safe
    .replace(/((?:authorization|set-cookie|cookie)["']?\s*[:=]\s*)[^\r\n]*/gi, '$1<redacted>')
    .replace(/(\/mcp\/)[A-Za-z0-9_-]{20,}/g, '$1<redacted>')
    .replace(/(Bearer\s+)[^\s"',;]+/gi, '$1<redacted>')
    .replace(/((?:authorization|cookie|set-cookie|authtoken|api[_-]?key|runtime[_-]?key|tunnel[_-]?token|token|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;]+)/gi, '$1<redacted>')
    .replace(/([?&](?:[^=&\s]*(?:token|secret|key)[^=&\s]*)=)[^&\s"']*/gi, '$1<redacted>')
}

export class ProviderLogBuffer {
  private entries: ProviderLogEntry[] = []
  private bytes = 0
  constructor(private readonly provider: McpRemoteProviderKind, private readonly secrets: () => string[] = () => [], private readonly changed: () => void = () => undefined) {}
  add(source: ProviderLogEntry['source'], text: string, level: ProviderLogEntry['level'] = source === 'stderr' ? 'warn' : 'info'): void {
    const safe = redactProviderText(text, this.secrets()).slice(0, 16384)
    if (!safe.trim()) return
    this.entries.push({ at: Date.now(), provider: this.provider, source, level, text: safe })
    this.bytes += Buffer.byteLength(safe)
    while (this.entries.length > 1000 || this.bytes > 1024 * 1024) this.bytes -= Buffer.byteLength(this.entries.shift()!.text)
    this.changed()
  }
  snapshot(): ProviderLogEntry[] { return this.entries.map((entry) => ({ ...entry })) }
  clear(): void { this.entries = []; this.bytes = 0; this.changed() }
  attach(stream: Readable | null | undefined, source: 'stdout' | 'stderr', observe?: (line: string) => void): void {
    if (!stream) return
    const decoder = new StringDecoder('utf8')
    let pending = ''; let dropped = false
    const accept = (text: string) => {
      const lines = (pending + text).split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (dropped) { this.add(source, '[超长日志已丢弃]'); dropped = false; continue }
        this.add(source, line); observe?.(line)
      }
      // 不按任意字节切行，避免密钥跨分片绕过脱敏；超长行整体丢弃。
      if (pending.length > 65536) { pending = ''; dropped = true }
    }
    stream.on('data', (chunk: Buffer) => accept(decoder.write(chunk)))
    stream.once('end', () => { accept(decoder.end()); if (!dropped && pending) { this.add(source, pending); observe?.(pending) }; pending = '' })
  }
}
