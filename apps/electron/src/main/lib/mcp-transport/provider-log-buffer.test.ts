import { it, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { ProviderLogBuffer, redactProviderText } from './provider-log-buffer'

it('Given 分片UTF8与凭据日志 When 收集stdout/stderr Then 完整解码且入库前脱敏', () => {
  const logs = new ProviderLogBuffer('ngrok', () => ['private-token'])
  const output = new PassThrough()
  logs.attach(output, 'stderr')
  const bytes = Buffer.from('错误 private-token Authorization: Bearer unsafe\n')
  output.write(bytes.subarray(0, 2)); output.write(bytes.subarray(2, 17)); output.write(bytes.subarray(17))
  const saved = JSON.stringify(logs.snapshot())
  expect(saved).toContain('错误'); expect(saved).not.toContain('private-token'); expect(saved).not.toContain('unsafe')
  expect(redactProviderText('https://x/mcp/' + 'x'.repeat(43) + '?token=abc Cookie: xyz')).not.toContain('abc')
  for (let i = 0; i < 1001; i++) logs.add('stdout', String(i))
  expect(logs.snapshot()).toHaveLength(1000)
  logs.clear(); expect(logs.snapshot()).toHaveLength(0)
})
