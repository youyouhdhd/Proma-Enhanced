import { expect } from 'bun:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage, SDKResultMessage } from '@proma/shared'
import { Type } from 'typebox'
import { PiAgentAdapter } from './pi-agent-adapter'

const mode = process.argv[2]
if (!mode) throw new Error('缺少测试模式')
await (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'proma-final-answer-'))
      const adapter = new PiAgentAdapter()
      const sessionId = `final-${mode}`
      let count = 0, tools = 0, file: string | undefined
      let bindings: Record<string, string> = {}
      let interrupt: Promise<void> | undefined
      let serverError: unknown
      const payloads: Array<Record<string, unknown>> = []
      const server = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.from(chunk))
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          payloads.push(body); count++
          if (count === 3 && mode === 'cancel') { adapter.abort(sessionId); res.end(); return }
          if (count === 3 && mode === 'interrupt') {
            interrupt = adapter.sendQueuedMessage(sessionId, { type: 'user', uuid: 'new-input', session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: '新消息' } }, { interrupt: true })
            res.end(); return
          }
          if (count === 3 && mode === 'http-error') {
            res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture failure' } })); return
          }
          const tool = count === 1 || (count === 3 && mode === 'unexpected-tool')
          const text = !tool && (mode === 'normal' || (count >= 3 && mode !== 'empty'))
          const type = tool ? 'tool_use' : text ? 'text' : 'thinking'
          const events = [
            { type: 'message_start', message: { id: `fixture-${count}`, model: 'fixture', usage: { input_tokens: 10, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: tool ? { type, id: `call-${count}`, name: 'SdkStatus', input: {} } : { type, [type]: '' } },
            { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{}' } : { type: `${type}_delta`, [type]: count === 4 ? '新消息的结果' : '验证通过，PASS=25' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } },
            { type: 'message_stop' },
          ]
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
        } catch (error) { serverError = error; res.destroy() }
      })
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture启动失败')
      const messages: SDKMessage[] = []
      try {
        for await (const message of adapter.query({
          sessionId, prompt: '验证后给结论', cwd: dir, provider: 'anthropic-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1/messages`, apiKey: 'fixture-key', model: 'fixture',
          systemPrompt: '只使用模拟工具', permissionMode: 'bypassPermissions', thinkingLevel: 'high', maxTurns: mode === 'limit' ? 2 : undefined,
          piAgentDir: join(dir, 'agent'), piSessionDir: join(dir, 'sessions'), exclusiveCustomTools: true,
          customTools: [{ name: 'SdkStatus', label: '模拟检查', description: '固定结果', parameters: Type.Object({}), execute: async () => { tools++; return { content: [{ type: 'text', text: 'PASS=25' }], details: {} } } }],
          onSessionId: (_id, path) => { file = path },
          onPiEntryBindings: value => { bindings = { ...bindings, ...value } },
        })) messages.push(message)
        await interrupt
        expect(serverError).toBeUndefined()
        expect(tools).toBe(1)
        const results = messages.filter((m): m is SDKResultMessage => m.type === 'result')
        if (mode === 'cancel') expect(results).toHaveLength(0)
        else {
          expect(results).toHaveLength(1)
          const succeeds = ['normal', 'recover', 'interrupt'].includes(mode)
          expect(results[0]?.subtype === 'success').toBe(succeeds)
          if (mode !== 'limit') expect(results[0]?.final_answer?.status).toBe(succeeds ? 'present' : 'missing')
        }
        expect(count).toBe(mode === 'normal' || mode === 'limit' ? 2 : mode === 'interrupt' ? 4 : 3)
        if (count >= 3) {
          expect(payloads[2]?.tools).toBeUndefined()
          expect(payloads[2]?.max_tokens).toBeLessThanOrEqual(8192)
        }
        if (mode === 'recover') {
          expect(results[0]?.usage).toMatchObject({ input_tokens: 30, output_tokens: 60 })
          expect(file).toBeDefined()
          const entries = readFileSync(file!, 'utf8').trim().split('\n').map(line => JSON.parse(line))
          expect(entries.filter(e => e.message?.role === 'assistant')).toHaveLength(3)
          expect(entries.at(-1).message.content[0].type).toBe('text')
          const final = messages.findLast((message): message is import('@proma/shared').SDKAssistantMessage => message.type === 'assistant')
          expect(final?.uuid).toBeDefined()
          expect(bindings[final!.uuid!]).toBe(entries.at(-1).id)
          const { SessionManager } = await import('@earendil-works/pi-coding-agent')
          const reopened = SessionManager.open(file!, join(dir, 'sessions'), dir)
          expect(reopened.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'assistant')).toHaveLength(3)
          expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: '验证通过，PASS=25' }] })
        }
      } finally {
        adapter.abort(sessionId)
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
        rmSync(dir, { recursive: true, force: true })
      }
})()
