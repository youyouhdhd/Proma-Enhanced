import { expect, it, spyOn } from 'bun:test'
import { TunnelClientInstaller } from './tunnel-client-installer'

it('Given 旧 bridge 请求安装 When 自动安装停用 Then 明确报错且不访问网络', async () => {
  const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不得访问未经验证的安装源'))
  try {
    const result = await new TunnelClientInstaller().install()
    expect(result.installed).toBe(false)
    expect(result.errorCode).toBe('TUNNEL_CLIENT_INSTALL_DISABLED')
    expect(result.errorMessage).toContain('PATH')
    expect(network).not.toHaveBeenCalled()
  } finally { network.mockRestore() }
})
