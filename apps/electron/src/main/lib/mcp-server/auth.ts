/** MCP Server 请求认证（V6：bearer / managed-bearer；期望 token 由 Main 解析后传入，不在 config 中持有明文） */

import { timingSafeEqual, createHash } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { PromaMcpServerConfig } from '@proma/shared'

export function isRequestAuthorized(
  auth: { type: PromaMcpServerConfig['auth']['type'] },
  /** 生效的 Bearer token：bearer → 配置值；managed-bearer → safeStorage 解密值 */
  expectedToken: string | undefined,
  authorizationHeader: IncomingHttpHeaders['authorization'],
): boolean {
  if (auth.type === 'none') return true
  if (!expectedToken) return false // 凭据缺失或解密失败时必须拒绝
  const provided = typeof authorizationHeader === 'string' ? authorizationHeader : ''
  const match = /^Bearer\s+(.+)$/.exec(provided)
  if (!match) return false
  const expected = createHash('sha256').update(expectedToken ?? '').digest()
  const actual = createHash('sha256').update(match[1] ?? '').digest()
  return timingSafeEqual(expected, actual)
}
