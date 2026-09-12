import { randomBytes, createHash } from 'node:crypto'
import type { McpRemoteTask, McpAgentAttempt } from '@proma/shared'

export type McpTaskKind = 'analysis' | 'action'

export interface AgentRunOptions {
  kind: McpTaskKind
  approved: boolean
}

export interface AgentRunResult {
  summary: string
  waitingApproval?: boolean
  changedFiles?: string[]
  warnings?: string[]
}

export interface AnalysisJobRunner {
  run(
    workspaceId: string,
    instruction: string,
    signal: AbortSignal,
    bindSession: (id: string) => void,
    targetId?: string,
    audit?: (attempt: McpAgentAttempt) => void,
    options?: AgentRunOptions,
  ): Promise<string | AgentRunResult>
}

type AuthorizeTask = (workspaceId: string, kind?: McpTaskKind) => void

/** 内存中的 instruction 不进入任务快照、诊断或普通日志；实际会话由既有 Agent 管理。 */
export class AnalysisTaskQueue {
  private readonly tasks = new Map<string, McpRemoteTask>()
  private readonly pending = new Map<string, { instruction: string; signature: string; kind: McpTaskKind; approved: boolean }>()
  private readonly active = new Map<string, AbortController>()
  private readonly starts: number[] = []
  private readonly recent = new Map<string, { id: string; at: number }>()

  constructor(
    private readonly runner: AnalysisJobRunner,
    private readonly authorize: AuthorizeTask,
    private readonly changed: (tasks: McpRemoteTask[]) => void = () => undefined,
    restored: McpRemoteTask[] = [],
    private readonly limits: () => { maxConcurrent: number; maxQueued: number } = () => ({ maxConcurrent: 1, maxQueued: 3 }),
  ) {
    for (const task of (Array.isArray(restored) ? restored : []).slice(-100)) {
      if (!task || !/^pt_[a-f0-9]{32}$/.test(task.id) || typeof task.workspaceId !== 'string') continue
      const kind: McpTaskKind = task.kind === 'action' ? 'action' : 'analysis'
      const interrupted = ['queued', 'planning', 'running', 'waiting_approval'].includes(task.status)
      const approval = task.approval && typeof task.approval === 'object' ? {
        required: task.approval.required === true,
        ...(Number.isFinite(task.approval.requestedAt) ? { requestedAt: task.approval.requestedAt } : {}),
        ...(Number.isFinite(task.approval.decidedAt) ? { decidedAt: task.approval.decidedAt } : {}),
        ...(task.approval.decision === 'approved' || task.approval.decision === 'denied' ? { decision: task.approval.decision } : {}),
      } : undefined
      this.tasks.set(task.id, {
        id: task.id,
        workspaceId: task.workspaceId,
        kind,
        sessionId: typeof task.sessionId === 'string' ? task.sessionId : undefined,
        createdAt: Number.isFinite(task.createdAt) ? task.createdAt : Date.now(),
        targetId: typeof task.targetId === 'string' ? task.targetId : undefined,
        attempts: Array.isArray(task.attempts) ? task.attempts.filter((attempt) => attempt && typeof attempt.targetId === 'string' && Number.isFinite(attempt.startedAt) && Number.isFinite(attempt.endedAt) && ['completed', 'failed', 'cancelled'].includes(attempt.resultType)).slice(-100).map((attempt) => ({ targetId: attempt.targetId, startedAt: attempt.startedAt, endedAt: attempt.endedAt, resultType: attempt.resultType })) : [],
        updatedAt: interrupted ? Date.now() : (Number.isFinite(task.updatedAt) ? task.updatedAt : Date.now()),
        status: interrupted ? 'failed' : task.status,
        summary: typeof task.summary === 'string' ? task.summary.slice(0, 16000) : undefined,
        changed_files: Array.isArray(task.changed_files) ? task.changed_files.filter((path): path is string => typeof path === 'string').slice(0, 200) : [],
        warnings: interrupted ? ['应用重启，任务已中断；不会自动重新调用模型。'] : Array.isArray(task.warnings) ? task.warnings.filter((warning): warning is string => typeof warning === 'string').slice(0, 8) : [],
        ...(approval ? { approval } : {}),
        ...(typeof task.errorCode === 'string' ? { errorCode: task.errorCode.slice(0, 120) } : {}),
      })
    }
  }

  snapshot(): McpRemoteTask[] {
    return [...this.tasks.values()].map((task) => ({
      ...task,
      attempts: task.attempts?.map((attempt) => ({ ...attempt })),
      changed_files: [...task.changed_files],
      warnings: [...task.warnings],
      ...(task.approval ? { approval: { ...task.approval } } : {}),
    }))
  }

  start(workspaceId: string, instruction: string, targetId?: string, kind: McpTaskKind = 'analysis', requiresApproval = false): McpRemoteTask {
    this.authorize(workspaceId, kind)
    if (!instruction.trim() || instruction.length > 12000) throw new Error('TASK_INSTRUCTION_INVALID')
    const cleanInstruction = instruction.trim()
    const signature = createHash('sha256').update(kind + '\0' + workspaceId + '\0' + (targetId ?? '') + '\0' + cleanInstruction).digest('hex')
    for (const [id, pending] of this.pending) if (pending.signature === signature) return this.get(id)
    const now = Date.now()
    for (const [key, item] of this.recent) if (now - item.at > 30000) this.recent.delete(key)
    const duplicate = this.recent.get(signature)
    if (duplicate && this.tasks.get(duplicate.id)?.status === 'completed') return this.get(duplicate.id)
    while (this.starts.length && this.starts[0]! < now - 60_000) this.starts.shift()
    const limits = this.limits()
    if (limits.maxQueued === 0 && this.active.size + [...this.tasks.values()].filter((task) => task.status === 'queued').length >= limits.maxConcurrent) throw new Error('BUSY')
    if (this.starts.length >= 6 || [...this.tasks.values()].filter((task) => task.status === 'queued').length >= limits.maxQueued + Math.max(0, limits.maxConcurrent - this.active.size)) throw new Error('TASK_RATE_LIMIT')
    const task: McpRemoteTask = {
      id: 'pt_' + randomBytes(16).toString('hex'),
      workspaceId,
      kind,
      targetId,
      attempts: [],
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      changed_files: [],
      warnings: [],
      ...(requiresApproval ? { approval: { required: true } } : {}),
    }
    this.tasks.set(task.id, task)
    this.pending.set(task.id, { instruction: cleanInstruction, signature, kind, approved: kind !== 'action' || !requiresApproval })
    this.starts.push(now)
    this.recent.set(signature, { id: task.id, at: now })
    this.trimTasks()
    this.emit()
    queueMicrotask(() => { void this.drain() })
    return { ...task, attempts: [], changed_files: [], warnings: [], ...(task.approval ? { approval: { ...task.approval } } : {}) }
  }

  get(id: string): McpRemoteTask {
    const task = this.tasks.get(id)
    if (!task) throw new Error('TASK_NOT_FOUND')
    this.authorize(task.workspaceId, task.kind === 'action' ? 'action' : 'analysis')
    return {
      ...task,
      attempts: task.attempts?.map((attempt) => ({ ...attempt })),
      changed_files: [...task.changed_files],
      warnings: [...task.warnings],
      ...(task.approval ? { approval: { ...task.approval } } : {}),
    }
  }

  approve(id: string): McpRemoteTask {
    const task = this.tasks.get(id)
    if (!task) throw new Error('TASK_NOT_FOUND')
    if (task.kind !== 'action' || task.status !== 'waiting_approval' || !task.approval?.required) throw new Error('APPROVAL_NOT_PENDING')
    this.authorize(task.workspaceId, 'action')
    const pending = this.pending.get(id)
    if (!pending) throw new Error('TASK_NOT_RESUMABLE')
    pending.approved = true
    task.approval = { ...task.approval, decidedAt: Date.now(), decision: 'approved' }
    task.status = 'queued'; task.updatedAt = Date.now(); task.errorCode = undefined
    this.emit(); queueMicrotask(() => { void this.drain() })
    return this.get(id)
  }

  deny(id: string): McpRemoteTask {
    const task = this.tasks.get(id)
    if (!task) throw new Error('TASK_NOT_FOUND')
    if (task.kind !== 'action' || task.status !== 'waiting_approval' || !task.approval?.required) throw new Error('APPROVAL_NOT_PENDING')
    this.authorize(task.workspaceId, 'action')
    task.approval = { ...task.approval, decidedAt: Date.now(), decision: 'denied' }
    task.status = 'cancelled'; task.updatedAt = Date.now(); task.errorCode = 'APPROVAL_DENIED'
    this.pending.delete(id)
    this.emit()
    return this.get(id)
  }

  cancel(id: string): void {
    const task = this.tasks.get(id)
    if (!task || !['queued', 'planning', 'running', 'waiting_approval'].includes(task.status)) return
    task.status = 'cancelled'; task.updatedAt = Date.now(); task.errorCode = 'TASK_CANCELLED'; this.pending.delete(id)
    this.active.get(id)?.abort()
    this.emit()
  }

  cancelAll(): void { for (const task of this.tasks.values()) this.cancel(task.id) }

  reconcile(): void {
    for (const task of this.tasks.values()) {
      if (!['queued', 'planning', 'running', 'waiting_approval'].includes(task.status)) continue
      try { this.authorize(task.workspaceId, task.kind === 'action' ? 'action' : 'analysis') } catch { this.cancel(task.id) }
    }
  }

  private trimTasks(): void {
    while (this.tasks.size > 100) {
      const old = [...this.tasks.values()].find((task) => !['queued', 'planning', 'running', 'waiting_approval'].includes(task.status))
      if (!old) break
      this.tasks.delete(old.id)
    }
  }

  private emit(): void {
    try { this.changed(this.snapshot()) }
    catch { console.error('[MCP] 任务状态保存失败；队列继续运行，请检查本地存储权限与剩余空间。') }
  }

  private async drain(): Promise<void> {
    if (this.active.size >= this.limits().maxConcurrent) return
    const task = [...this.tasks.values()].find((candidate) => candidate.status === 'queued')
    if (!task) return
    const pending = this.pending.get(task.id)
    if (!pending) { task.status = 'failed'; task.errorCode = 'TASK_NOT_RESUMABLE'; task.updatedAt = Date.now(); this.emit(); void this.drain(); return }
    const abort = new AbortController(); this.active.set(task.id, abort)
    const deadline = setTimeout(() => this.cancel(task.id), 10 * 60_000)
    const isPlanning = pending.kind === 'action' && !pending.approved
    try {
      this.authorize(task.workspaceId, pending.kind)
      task.status = isPlanning ? 'planning' : 'running'; task.updatedAt = Date.now(); this.emit()
      queueMicrotask(() => { void this.drain() })
      const raw = await this.runner.run(task.workspaceId, pending.instruction, abort.signal, (id) => { task.sessionId = id; this.emit() }, task.targetId, (attempt) => { (task.attempts ??= []).push(attempt); this.emit() }, { kind: pending.kind, approved: pending.approved })
      const result: AgentRunResult = typeof raw === 'string' ? { summary: raw } : raw
      if (abort.signal.aborted) task.status = 'cancelled'
      else if (result.waitingApproval) {
        task.status = 'waiting_approval'; task.approval = { required: true, requestedAt: Date.now() }; task.summary = result.summary.slice(0, 16000); task.changed_files = []; task.warnings = [...(result.warnings ?? [])].slice(0, 8)
      } else {
        this.authorize(task.workspaceId, pending.kind)
        task.status = 'completed'; task.summary = result.summary.slice(0, 16000); task.changed_files = [...new Set((result.changedFiles ?? []).filter((path) => typeof path === 'string'))].slice(0, 200); task.warnings = [...(result.warnings ?? [])].filter((warning): warning is string => typeof warning === 'string').slice(0, 8)
      }
    } catch (error) {
      const cancelled = abort.signal.aborted || error instanceof Error && (error.message === 'TASK_CANCELLED' || error.message === 'CANCELLED')
      task.status = cancelled ? 'cancelled' : 'failed'
      task.errorCode = cancelled ? 'TASK_CANCELLED' : error instanceof Error ? error.message.slice(0, 120) : 'TASK_FAILED'
      task.warnings = [cancelled ? '任务已取消。' : '任务未完成，请在本地任务会话查看详情。']
    } finally {
      clearTimeout(deadline); this.active.delete(task.id)
      if (task.status !== 'waiting_approval') this.pending.delete(task.id)
      task.updatedAt = Date.now(); this.emit(); void this.drain()
    }
  }
}
