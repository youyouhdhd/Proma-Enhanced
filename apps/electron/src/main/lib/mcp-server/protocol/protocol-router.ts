/** 复用官方 era 判定，避免只根据 initialize 方法猜测协议。 */
import { isLegacyRequest } from '@modelcontextprotocol/server'
import { toWebRequest } from '@modelcontextprotocol/node'
import type { IncomingMessage } from 'node:http'

export async function usesLegacyProtocol(req: IncomingMessage, body: unknown): Promise<boolean> {
  if (process.env.NODE_ENV === 'development' && process.env.PROMA_ENABLE_LEGACY_MCP === '1') return true
  return isLegacyRequest(await toWebRequest(req, body), body)
}
