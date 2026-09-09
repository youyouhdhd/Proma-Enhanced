/** V10：未验证的安装元数据入口已停用；保留旧 IPC 的明确失败响应。 */
import type { PromaMcpTunnelDetection } from '@proma/shared'

export class TunnelClientInstaller {
  async install(): Promise<PromaMcpTunnelDetection> {
    return {
      installed: false,
      errorCode: 'TUNNEL_CLIENT_INSTALL_DISABLED',
      errorMessage: '自动安装已停用。请从 PATH 检测或选择已有的完整 tunnel-client 程序。',
    }
  }
}
