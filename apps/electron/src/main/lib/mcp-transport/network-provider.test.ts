import { it, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { PublicMcpIngress } from './public-ingress'
import { NetworkProvider } from './network-provider'
import { NgrokProvider } from './ngrok-provider'

it('Given ngrok 稳定域名与Token When 启动/诊断 Then Token仅进env且诊断失败不杀进程', async () => {
  const ingress = new PublicMcpIngress({ list: () => [], call: async () => ({ content: [] }) }, () => 's'.repeat(43), 'probe')
  await ingress.start(0)
  let killed = 0; let failing = false
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
  const child = Object.assign(new EventEmitter(), { pid: 100, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { killed++; return true } }) as unknown as ChildProcess
  const provider = new NgrokProvider({ hostname: 'https://assigned.ngrok-free.app', authSource: 'proma-secret' }, ingress, () => 's'.repeat(43), () => 'PRIVATE_NGROK_TOKEN', 'probe', () => undefined, {
    command: async (_exe, args) => args.includes('--help') ? '--url --config --log' : 'ngrok version fixture',
    spawn: (_exe, args, options) => { calls.push({ args, env: options.env }); return child },
    probe: async () => { if (failing) throw new Error('offline'); return { modern: true, toolCount: 7, workspaceList: true } },
  })
  try {
    const ready = await provider.start(); expect(ready.phase).toBe('ready'); expect(ready.pid).toBe(100)
    expect(calls[0]?.env?.NGROK_AUTHTOKEN).toBe('PRIVATE_NGROK_TOKEN')
    expect(calls[0]?.args.join(' ')).not.toContain('PRIVATE_NGROK_TOKEN')
    expect(JSON.stringify(ready)).not.toContain('PRIVATE_NGROK_TOKEN')
    failing = true; expect((await provider.diagnose()).status.phase).toBe('degraded'); expect(killed).toBe(0)
    failing = false; expect((await provider.diagnose()).status.phase).toBe('ready')
  } finally { await provider.stop(); await ingress.stop() }
})

it('Given Tailscale 登录与既有路由 When preflight Then 拒绝未登录或覆盖其他服务', async () => {
  for (const testCase of ['login', 'occupied', 'ready']) {
    const ingress = new PublicMcpIngress({ list: () => [], call: async () => ({ content: [] }) }, () => 's'.repeat(43), 'probe')
    await ingress.start(0)
    const calls: string[][] = []
    const child = Object.assign(new EventEmitter(), { pid: 101, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcess
    const provider = new NetworkProvider('tailscale-funnel', {}, ingress, () => 's'.repeat(43), () => undefined, 'probe', () => undefined, {
      command: async (_exe, args) => args.includes('--help') ? '--https --bg' : args[0] === 'version' ? '1.102.3' : args[0] === 'status'
        ? JSON.stringify({ BackendState: testCase === 'login' ? 'NeedsLogin' : 'Running', Self: { DNSName: 'fixture.tailnet.ts.net.' } })
        : JSON.stringify(testCase === 'occupied' ? { TCP: { '443': {} } } : {}),
      spawn: (_exe, args) => { calls.push(args); return child }, probe: async () => ({ modern: true, toolCount: 5, workspaceList: true }),
    })
    try {
      const status = await provider.start()
      if (testCase === 'ready') { expect(status.phase).toBe('ready'); expect(status.endpoint?.publicUrl).toBe('https://fixture.tailnet.ts.net'); expect(calls[0]?.[1]).toBe('--https=443') }
      else { expect(status.errorCode).toBe(testCase === 'login' ? 'TAILSCALE_LOGIN_REQUIRED' : 'TAILSCALE_FUNNEL_ALREADY_CONFIGURED'); expect(calls).toHaveLength(0) }
    } finally { await provider.stop(); await ingress.stop() }
  }
})
