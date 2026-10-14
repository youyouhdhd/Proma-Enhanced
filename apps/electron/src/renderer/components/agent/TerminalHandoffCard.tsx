import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { TerminalSquare } from 'lucide-react'
import type { AskUserRequest, AskUserResponse } from '@proma/shared'
import { Button } from '@/components/ui/button'
import {
  allPendingAskUserRequestsAtom,
  askUserDraftsAtom,
  agentSidePanelOpenAtomFamily,
  agentDiffPanelTabAtom,
  getTerminalSidePanelTab,
} from '@/atoms/agent-atoms'

interface TerminalHandoffCardProps {
  request: AskUserRequest
  onCancel: () => void
}

/** 复用问答生命周期；操作反馈只唤醒 Agent，真实输入留在原终端。 */
export function TerminalHandoffCard({ request, onCancel }: TerminalHandoffCardProps): React.ReactElement {
  const [drafts, setDrafts] = useAtom(askUserDraftsAtom)
  const setRequests = useSetAtom(allPendingAskUserRequestsAtom)
  const setPanelOpen = useSetAtom(agentSidePanelOpenAtomFamily(request.sessionId))
  const setPanelTabs = useSetAtom(agentDiffPanelTabAtom)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const submittingRef = React.useRef(false)
  const message = drafts.get(request.requestId)?.answers.get(0)?.customText ?? ''
  const terminal = request.terminal!

  const setMessage = (text: string): void => {
    setDrafts((previous) => {
      const next = new Map(previous)
      next.set(request.requestId, {
        activeTab: 0,
        focusedOptIdx: -1,
        answers: new Map([[0, { selected: [], customText: text, showCustom: true }]]),
      })
      return next
    })
  }

  const openTerminal = (): void => {
    setPanelOpen(true)
    setPanelTabs((previous) => new Map(previous).set(request.sessionId, getTerminalSidePanelTab(terminal.terminalId)))
    window.dispatchEvent(new CustomEvent('proma:focus-terminal', { detail: { terminalId: terminal.terminalId } }))
  }

  const respond = async (outcome: NonNullable<AskUserResponse['terminalResponse']>['outcome']): Promise<void> => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      await window.electronAPI.respondAskUser({
        requestId: request.requestId,
        answers: {},
        terminalResponse: { outcome, message: message.trim() || undefined },
      })
      setRequests((previous) => {
        const next = new Map(previous)
        const remaining = (next.get(request.sessionId) ?? []).filter((item) => item.requestId !== request.requestId)
        if (remaining.length) next.set(request.sessionId, remaining)
        else next.delete(request.sessionId)
        return next
      })
      setDrafts((previous) => {
        const next = new Map(previous)
        next.delete(request.requestId)
        return next
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '反馈提交失败，请重试')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <section className="mx-4 mb-3 max-h-[60vh] shrink-0 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg scrollbar-thin" aria-label="终端接管">
      <div className="flex items-center gap-2 text-sm font-medium" role="status">
        <TerminalSquare className="size-4 text-primary" aria-hidden="true" />
        等待你操作终端
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{request.questions[0]?.question}</p>
      <p className="mt-1 text-xs text-muted-foreground">{terminal.title} · 请在终端中输入，密码不要填写到这里。</p>
      <p className="mt-1 text-xs text-muted-foreground">等待你的回复，不会自动超时。停止任务或退出应用会结束当前等待。</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={openTerminal}>打开终端</Button>
      <label className="mt-3 block text-xs text-muted-foreground" htmlFor={`terminal-feedback-${request.requestId}`}>操作反馈（可选）</label>
      <textarea
        id={`terminal-feedback-${request.requestId}`}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        maxLength={4_000}
        rows={2}
        disabled={submitting}
        className="mt-1 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={submitting} onClick={() => void respond('completed')}>{submitting ? '正在提交…' : '已完成，继续'}</Button>
        <Button size="sm" variant="outline" disabled={submitting} onClick={() => void respond('problem')}>遇到问题</Button>
        <Button size="sm" variant="ghost" disabled={submitting} onClick={onCancel} title="停止 Agent，终端保留；可在终端按 Ctrl+C 中断程序">取消任务</Button>
      </div>
    </section>
  )
}
