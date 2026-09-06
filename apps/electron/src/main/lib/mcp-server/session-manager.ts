/**
 * MCP 会话管理：按 Mcp-Session-Id 维护 transport + server，
 * 空闲 TTL 回收 + stopAll 全量关闭，防止 Session Map 无限增长。
 */

import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

export interface SessionEntry {
  transport: StreamableHTTPServerTransport
  server: Server
  createdAt: number
  lastUsedAt: number
  /** initialize 时的 endpoint 作用域（/mcp = 全部；/mcp/<profileId> = Profile 子集） */
  profileId?: string
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  get size(): number {
    return this.sessions.size
  }

  get(id: string): SessionEntry | undefined {
    return this.sessions.get(id)
  }

  set(id: string, entry: SessionEntry): void {
    this.sessions.set(id, entry)
  }

  touch(id: string): void {
    const entry = this.sessions.get(id)
    if (entry) entry.lastUsedAt = Date.now()
  }

  delete(id: string): boolean {
    return this.sessions.delete(id)
  }

  /** 启动空闲回收（每分钟扫描一次，空闲超过 TTL 的会话回调关闭） */
  startIdleSweep(onExpire: (sessionId: string) => void, ttlMs = 30 * 60 * 1000): void {
    this.stopIdleSweep()
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, entry] of this.sessions) {
        if (now - entry.lastUsedAt > ttlMs) onExpire(id)
      }
    }, 60 * 1000)
    this.sweepTimer.unref?.()
  }

  stopIdleSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  closeAll(): void {
    for (const entry of this.sessions.values()) {
      try { void entry.transport.close() } catch { /* 已关闭 */ }
    }
    this.sessions.clear()
  }
}
