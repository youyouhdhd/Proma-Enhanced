/** 只从运行态 health URL 派生日志地址，不接受 renderer 提供的任意 URL。 */
export function getTunnelLogUrl(healthUrl?: string): string {
  if (!healthUrl) throw new Error('Tunnel 尚未提供本地管理地址，请先启动连接')
  const url = new URL(healthUrl)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Tunnel 管理地址必须是无凭据的本机 HTTP 地址')
  }
  // 使用 origin 丢弃原路径、query 和 fragment，避免传递任何附加字段。
  return new URL('/ui#logs', url.origin).href
}
