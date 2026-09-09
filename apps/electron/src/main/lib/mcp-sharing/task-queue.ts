import { randomBytes, createHash } from 'node:crypto'
import type { McpRemoteTask } from '@proma/shared'

export interface AnalysisJobRunner {
  run(workspaceId: string, instruction: string, signal: AbortSignal, bindSession: (id: string) => void): Promise<string>
}
/** 内存中的 instruction 不进入任务快照、诊断或普通日志；实际会话由既有 Agent 管理。 */
export class AnalysisTaskQueue {
  private readonly tasks = new Map<string, McpRemoteTask>()
  private readonly pending = new Map<string, { instruction: string; signature: string }>()
  private active?: { id: string; abort: AbortController }
  private readonly starts: number[] = []
  private readonly recent = new Map<string, { id: string; at: number }>()
  constructor(private readonly runner: AnalysisJobRunner, private readonly authorize: (workspaceId: string) => void,
    private readonly changed: (tasks: McpRemoteTask[]) => void = () => undefined, restored: McpRemoteTask[] = []) {
    for (const task of (Array.isArray(restored) ? restored : []).slice(-100)) {
      if (!task || !/^pt_[a-f0-9]{32}$/.test(task.id) || typeof task.workspaceId !== 'string') continue
      const interrupted = ['queued', 'running', 'waiting_approval'].includes(task.status)
      this.tasks.set(task.id, { id: task.id, workspaceId: task.workspaceId, sessionId: task.sessionId, createdAt: task.createdAt,
        updatedAt: interrupted ? Date.now() : task.updatedAt, status: interrupted ? 'failed' : task.status,
        summary: typeof task.summary === 'string' ? task.summary.slice(0, 16000) : undefined,
        changed_files: [], warnings: interrupted ? ['应用重启，分析任务已中断；不会自动重新调用模型。'] : Array.isArray(task.warnings) ? task.warnings.filter((w) => typeof w === 'string').slice(0, 8) : [] })
    }
  }
  snapshot(): McpRemoteTask[] { return [...this.tasks.values()].map((t) => ({ ...t, changed_files: [...t.changed_files], warnings: [...t.warnings] })) }
  start(workspaceId: string, instruction: string): McpRemoteTask {
    this.authorize(workspaceId)
    if (!instruction.trim() || instruction.length > 12000) throw new Error('TASK_INSTRUCTION_INVALID')
    const signature = createHash('sha256').update(workspaceId + '\0' + instruction.trim()).digest('hex')
    for (const [id, pending] of this.pending) if (pending.signature === signature) return this.get(id)
    const now = Date.now()
    for (const [key, item] of this.recent) if (now - item.at > 30000) this.recent.delete(key)
    const duplicate = this.recent.get(signature)
    if (duplicate && this.tasks.get(duplicate.id)?.status === 'completed') return this.get(duplicate.id)
    while (this.starts.length && this.starts[0]! < now - 60_000) this.starts.shift()
    if (this.starts.length >= 6 || [...this.tasks.values()].filter((t) => t.status === 'queued').length >= (this.active ? 3 : 4)) throw new Error('TASK_RATE_LIMIT')
    const task: McpRemoteTask = { id: 'pt_' + randomBytes(16).toString('hex'), workspaceId, createdAt: now, updatedAt: now, status: 'queued', changed_files: [], warnings: [] }
    this.tasks.set(task.id, task); this.pending.set(task.id, { instruction: instruction.trim(), signature }); this.starts.push(now)
    this.recent.set(signature, { id: task.id, at: now })
    while (this.tasks.size > 100) {
      const old = [...this.tasks.values()].find((t) => !['queued', 'running'].includes(t.status))
      if (!old) break; this.tasks.delete(old.id)
    }
    this.emit(); queueMicrotask(() => { void this.drain() }); return { ...task }
  }
  get(id: string): McpRemoteTask {
    const task = this.tasks.get(id)
    if (!task) throw new Error('TASK_NOT_FOUND')
    this.authorize(task.workspaceId)
    return { ...task, changed_files: [...task.changed_files], warnings: [...task.warnings] }
  }
  cancel(id: string): void {
    const task = this.tasks.get(id)
    if (!task || !['queued', 'running', 'waiting_approval'].includes(task.status)) return
    task.status = 'cancelled'; task.updatedAt = Date.now(); this.pending.delete(id)
    if (this.active?.id === id) this.active.abort.abort()
    this.emit()
  }
  cancelAll(): void { for (const task of this.tasks.values()) this.cancel(task.id) }
  reconcile(): void { for (const task of this.tasks.values()) { try { this.authorize(task.workspaceId) } catch { this.cancel(task.id) } } }
  private emit(): void {
    try { this.changed(this.snapshot()) }
    catch { console.error('[MCP] 分析任务状态保存失败；队列继续运行，请检查本地存储权限与剩余空间。') }
  }
  private async drain(): Promise<void> {
    if (this.active) return
    const task = [...this.tasks.values()].find((t) => t.status === 'queued')
    if (!task) return
    const abort = new AbortController(); this.active = { id: task.id, abort }
    const deadline = setTimeout(() => this.cancel(task.id), 10 * 60_000)
    try {
      this.authorize(task.workspaceId); task.status = 'running'; task.updatedAt = Date.now(); this.emit()
      const summary = await this.runner.run(task.workspaceId, this.pending.get(task.id)!.instruction, abort.signal, (id) => { task.sessionId = id; this.emit() })
      if (abort.signal.aborted) task.status = 'cancelled'
      else { this.authorize(task.workspaceId); task.status = 'completed'; task.summary = summary.slice(0, 16000) }
    } catch (error) { task.status = abort.signal.aborted || error instanceof Error && error.message === 'TASK_CANCELLED' ? 'cancelled' : 'failed'; task.warnings = ['分析未完成，请在本地任务会话查看详情。'] }
    finally {
      clearTimeout(deadline); this.pending.delete(task.id); this.active = undefined; task.updatedAt = Date.now(); this.emit(); void this.drain()
    }
  }
}
