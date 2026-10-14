import { afterAll, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/anthropic-messages'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { normalizeThinkTagsInContentBlocks } from '@proma/session-core'
import { injectDeepSeekReasoningLevel } from './pi-deepseek-reasoning-request-settings'
import { resolveReasoningProfile } from '@proma/shared'

interface Event { type: string; [key: string]: unknown }
interface Fixture { events?: Event[]; body?: string; status?: number; crlf?: boolean; slow?: boolean; truncate?: boolean }
const start: Event = { type: 'message_start', message: { id: 'fixture', model: 'DeepSeek-V4.1-Flash', usage: { input_tokens: 1, output_tokens: 0 } } }
const begin = (index: number, type: string): Event => ({ type: 'content_block_start', index, content_block: { type, ...(type === 'thinking' ? { thinking: '' } : { text: '' }) } })
const delta = (index: number, type: string, value: string): Event => ({ type: 'content_block_delta', index, delta: { type, [type === 'thinking_delta' ? 'thinking' : 'text']: value } })
const end = (index: number): Event => ({ type: 'content_block_stop', index })
const terminal = (reason = 'end_turn'): Event[] => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 5 } }, { type: 'message_stop' }]
const thinking = [begin(0, 'thinking'), delta(0, 'thinking_delta', '检查中。'), end(0)]
const answer = [begin(1, 'text'), delta(1, 'text_delta', 'PASS=25，验证通过。'), end(1)]
const fixtures = new Map<string, Fixture>()
const requests = new Map<string, Record<string, unknown>>()
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  const id = body.model as string
  requests.set(id, body)
  const fixture = fixtures.get(id)!
  res.writeHead(fixture.status ?? 200, { 'Content-Type': fixture.status ? 'application/json' : 'text/event-stream' })
  if (fixture.slow) { res.write('event: ping\ndata: {"type":"ping"}\n\n'); return }
  const newline = fixture.crlf ? '\r\n' : '\n'
  const text = fixture.body ?? fixture.events!.map(e => `event: ${e.type}${newline}data: ${JSON.stringify(e)}${newline}${newline}`).join('')
  const bytes = Buffer.from(text)
  for (let i = 0; i < bytes.length; i += 13) {
    if (res.destroyed) return
    res.write(bytes.subarray(i, i + 13))
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  if (fixture.truncate) res.destroy(); else res.end()
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
if (!address || typeof address === 'string') throw new Error('隔离HTTP服务启动失败')
const root = `http://127.0.0.1:${address.port}`
const baseModel = { name: '隔离HTTP模型', api: 'anthropic-messages' as const, provider: 'fixture-provider', baseUrl: root, reasoning: true, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 384000, thinkingLevelMap: { low: 'low', high: 'high', max: 'max' } }
const context = normalizeContext({ messages: [{ role: 'user' as const, content: '验证后给结论', timestamp: 0 }] })
async function run(id: string, fixture: Fixture, options: Record<string, unknown> = {}) {
  fixtures.set(id, fixture)
  const result = await stream({ ...baseModel, id }, context, { apiKey: 'synthetic-dummy-key', cacheRetention: 'none', maxRetries: 0, timeoutMs: 3000, ...options }).result()
  return result
}
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('真实HTTP → Anthropic SDK → Pi SSE解析', () => {
  for (const [id, events] of [
    ['duplicate-index', [begin(0, 'text'), begin(0, 'text')]],
    ['unknown-stop', [end(9)]],
    ['delta-after-stop', [begin(0, 'text'), end(0), delta(0, 'text_delta', '不能静默丢失')]],
    ['invalid-index', [begin(-1, 'text')]],
  ] as const) {
    test(`Given ${id} When 解析 Then 明确协议错误`, async () => {
      const result = await run(id, { events: [start, ...events, ...terminal()] })
      expect(result.stopReason).toBe('error')
      expect(result.errorMessage).toContain('provider_stream_protocol_error')
    })
  }
  test('Given 合法思考和正文 When HTTP分片传输 Then 两个通道均保留', async () => {
    const result = await run('normal', { events: [start, ...thinking, ...answer, ...terminal()] })
    expect(result.stopReason).toBe('stop'); expect(result.content.map(b => b.type)).toEqual(['thinking', 'text'])
    expect(result.content[1]).toMatchObject({ text: 'PASS=25，验证通过。' })
  })
  test('Given CRLF和ping When 解析 Then 正文保持完整', async () => {
    const result = await run('crlf', { crlf: true, events: [start, { type: 'ping' }, ...answer, ...terminal()] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'PASS=25，验证通过。' })
  })
  test('Given 非连续块索引 When 正确声明 Then 不依赖数组下标', async () => {
    const result = await run('sparse', { events: [start, begin(7, 'text'), delta(7, 'text_delta', '完整答案'), end(7), ...terminal()] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: '完整答案' })
  })
  test('Given 重用已结束块索引 When 下一块为正文 Then 正确创建正文', async () => {
    const result = await run('reuse', { events: [start, ...thinking, begin(0, 'text'), delta(0, 'text_delta', '答案'), end(0), ...terminal()] })
    expect(result.content.map(b => b.type)).toEqual(['thinking', 'text'])
  })
  test('Given 结论发进thinking When 正常end_turn Then 复现只有思考却成功', async () => {
    const result = await run('thinking-only', { events: [start, begin(0, 'thinking'), delta(0, 'thinking_delta', '最终结论：验证通过。'), end(0), ...terminal()] })
    expect(result.stopReason).toBe('stop'); expect(result.content.map(b => b.type)).toEqual(['thinking'])
  })
  test('Given text_delta缺起始块 When 解析 Then 明确报告协议错误', async () => {
    const result = await run('missing-start', { events: [start, ...thinking, delta(1, 'text_delta', '丢失的结论'), ...terminal()] })
    expect(result.stopReason).toBe('error'); expect(result.errorMessage).toContain('provider_stream_protocol_error')
  })
  test('Given text_delta引用thinking块 When 解析 Then 明确报告协议错误', async () => {
    const result = await run('wrong-type', { events: [start, begin(0, 'thinking'), delta(0, 'thinking_delta', '思考'), delta(0, 'text_delta', '丢失的结论'), end(0), ...terminal()] })
    expect(result.stopReason).toBe('error'); expect(result.errorMessage).toContain('provider_stream_protocol_error')
  })
  test('Given 块未结束但消息结束 When 解析 Then 明确报告未闭合块', async () => {
    const result = await run('unclosed-block', { events: [start, begin(0, 'text'), delta(0, 'text_delta', '正文'), ...terminal()] })
    expect(result.stopReason).toBe('error'); expect(result.errorMessage).toContain('unclosed_blocks')
  })
  test('Given 正常结束但无内容 When 解析 Then 证实SDK未验最终答复', async () => {
    const result = await run('empty', { events: [start, ...terminal()] })
    expect(result.stopReason).toBe('stop'); expect(result.content).toEqual([])
  })
  test('Given 缺少message_stop When 连接结束 Then 报流不完整', async () => {
    const result = await run('missing-stop', { events: [start, ...answer, terminal()[0]!] })
    expect(result.stopReason).toBe('error'); expect(result.errorMessage).toContain('before message_stop')
  })
  test('Given 无stop_reason When 结束 Then 报终态缺失', async () => {
    const result = await run('missing-reason', { events: [start, ...answer, { type: 'message_stop' }] })
    expect(result.stopReason).toBe('error'); expect(result.errorMessage).toContain('without a stop reason')
  })
  test('Given 输出截断 When max_tokens Then 保留正文并标记length', async () => {
    const result = await run('length', { events: [start, ...answer, ...terminal('max_tokens')] })
    expect(result.stopReason).toBe('length'); expect(result.content[0]?.type).toBe('text')
  })
  test('Given 无效JSON When 解析 Then 报格式错误', async () => {
    const result = await run('bad-json', { body: 'event: message_start\ndata: {not-json}\n\n' })
    expect(result.stopReason).toBe('error')
  })
  test('Given SSE error事件 When 解析 Then 不伪报成功', async () => {
    const result = await run('error-event', { events: [start, { type: 'error', error: { type: 'overloaded_error', message: '模拟过载' } }] })
    expect(result.stopReason).toBe('error')
  })
  for (const status of [400, 401, 429, 500]) {
    test(`Given HTTP${status} When 请求 Then 返回明确错误且不自动重复调用`, async () => {
      const result = await run(`http-${status}`, { status, body: JSON.stringify({ type: 'error', error: { type: 'fixture_error', message: '模拟HTTP故障' } }) })
      expect(result.stopReason).toBe('error')
    })
  }
  test('Given 持续无正文 When 用户取消 Then 返回aborted', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 100)
    try { expect((await run('abort', { slow: true }, { signal: controller.signal })).stopReason).toBe('aborted') }
    finally { clearTimeout(timer) }
  })
})

describe('真实请求参数与UI归类契约', () => {
  for (const [id, signature, preserve, expectedType] of [
    ['unsigned-default', '', false, 'text'],
    ['unsigned-preserve', '', true, 'thinking'],
    ['signed-default', 'synthetic-signature', false, 'thinking'],
  ] as const) {
    test(`Given ${id}历史思考 When 工具后继续请求 Then 回传类型为${expectedType}`, async () => {
      fixtures.set(id, { events: [start, ...answer, ...terminal()] })
      const model = { ...baseModel, id, compat: { allowEmptySignature: preserve } }
      const replay = {
        messages: [
          ...context.messages,
          { role: 'assistant' as const, content: [{ type: 'thinking' as const, thinking: 'synthetic-reasoning-marker', thinkingSignature: signature }], api: 'anthropic-messages' as const, provider: model.provider, model: id, stopReason: 'stop' as const, timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
          { role: 'user' as const, content: '继续给最终结论', timestamp: 0 },
        ],
      }
      await stream(model, normalizeContext(replay), { apiKey: 'synthetic-dummy-key', maxRetries: 0, cacheRetention: 'none' }).result()
      const assistantRequest = (requests.get(id)?.messages as Array<{ role: string; content: Array<{ type: string }> }>).find(m => m.role === 'assistant')
      expect(assistantRequest?.content[0]?.type).toBe(expectedType)
    })
  }
  test('Given V4.1 high/max档位 When 通用Pi请求 Then 证实两个档位均未发送effort', async () => {
    for (const reasoning of ['high', 'max'] as const) {
      const id = `level-${reasoning}`; fixtures.set(id, { events: [start, ...answer, ...terminal()] })
      await streamSimple({ ...baseModel, id }, context, { apiKey: 'synthetic-dummy-key', reasoning, maxRetries: 0, cacheRetention: 'none' }).result()
      expect(requests.get(id)?.thinking).toMatchObject({ type: 'enabled', budget_tokens: 16384 })
      expect(requests.get(id)?.output_config).toBeUndefined()
    }
  })
  test('Given 已验证V4 profile When 专属参数注入 Then max明确发送且移除预算', () => {
    const result = injectDeepSeekReasoningLevel({ model: 'deepseek-v4-flash', thinking: { type: 'enabled', budget_tokens: 16384 } }, { profile: resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'anthropic-messages' }), thinkingLevel: 'max' })
    expect(result).toMatchObject({ thinking: { type: 'enabled' }, output_config: { effort: 'max' } })
    expect((result as { thinking: object }).thinking).not.toHaveProperty('budget_tokens')
  })
  test('Given 新V4.1模型 When 显式profile注入 Then 支持max且移除预算', () => {
    const original = { model: 'DeepSeek-V4.1-Flash', thinking: { type: 'enabled', budget_tokens: 16384 } }
    expect(injectDeepSeekReasoningLevel(original, { profile: resolveReasoningProfile({ modelId: original.model, transport: 'anthropic-messages' }), thinkingLevel: 'max' })).toMatchObject({ thinking: { type: 'enabled' }, output_config: { effort: 'max' } })
  })
  for (const [id, text, types] of [
    ['ordinary', '验证通过', ['text']],
    ['closed-tag', '<think>推理</think>验证通过', ['thinking', 'text']],
    ['unclosed-tag', '<think>推理，验证通过', ['text']],
    ['quoted-inline', '示例`<think>`。验证通过', ['text']],
    ['quoted-code-fence', '```xml\n<think>\n```\n验证通过', ['text']],
  ] as const) {
    test(`Given ${id}正文 When UI兼容处理 Then 核对块归属`, () => {
      expect(normalizeThinkTagsInContentBlocks([{ type: 'text', text }]).map(b => b.type)).toEqual([...types])
    })
  }
})
