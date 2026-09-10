import { it, expect } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { PublicMcpIngress } from './public-ingress'
import { NgrokProvider } from './ngrok-provider'

it('Given ngrok系统/自定义配置 When 启动与重启 Then 复用配置且固定地址不变、退出保留脱敏日志', async () => {
  for (const configSource of ['default', 'custom'] as const) {
    const ingress = new PublicMcpIngress({ list: () => [], call: async () => ({ content: [] }) }, () => 's'.repeat(43), 'probe')
    await ingress.start(0)
    const commands: string[][] = []; const launches: string[][] = []
    let child: ChildProcess | undefined
    let probes = 0
    const provider = new NgrokProvider({ authSource: 'system-config', configSource, configPath: 'C:\\fixture\\ngrok.yml', hostname: 'https://stable.ngrok.app' }, ingress,
      () => 's'.repeat(43), () => undefined, 'probe', () => undefined, {
        command: async (_exe, args) => { commands.push(args); return args[0] === 'version' ? 'ngrok 3.39.9' : 'Valid configuration' },
        spawn: (_exe, args, options) => {
          launches.push(args); expect(options.env?.NGROK_AUTHTOKEN).toBeUndefined(); expect(options.shell).toBe(false)
          expect(Object.keys(options.env ?? {}).some((name) => /^(https?|all)_proxy$/i.test(name))).toBe(false)
          child = Object.assign(new EventEmitter(), { pid: 101, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcess
          return child
        }, probe: async () => { probes++; if (probes % 2 === 1) throw new Error('offline'); return { modern: true, toolCount: 11, workspaceList: true } },
      })
    try {
      const first = await provider.start()
      expect(first.phase).toBe('ready')
      expect(commands.some((args) => args[0] === 'config' && args[1] === 'check')).toBe(true)
      expect(launches[0]?.includes('--config')).toBe(configSource === 'custom')
      expect(launches[0]?.join(' ')).not.toContain('web_addr')
      expect((await provider.start()).endpoint?.connectorUrl).toBe(first.endpoint?.connectorUrl)
      ;(child!.stderr as PassThrough).write('ERR_NGROK_334 endpoint already online token=private\n')
      child!.emit('close', 1)
      expect(provider.getStatus().errorCode).toBe('NGROK_ENDPOINT_CONFLICT')
      expect(JSON.stringify(provider.getStatus())).not.toContain('private')
      await provider.stop()
      expect(provider.getStatus().logs?.length).toBeGreaterThan(0)
    } finally { await provider.stop(); await ingress.stop() }
  }
})
