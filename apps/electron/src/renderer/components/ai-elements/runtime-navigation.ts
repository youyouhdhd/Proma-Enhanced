export type RuntimeNavigationKey = 'ArrowUp' | 'ArrowDown' | 'PageUp' | 'PageDown' | 'Home' | 'End'

export function nextPendingEventCount(input: {
  previousEventCount: number
  eventCount: number
  pendingEventCount: number
  isAtBottom: boolean
}): number {
  if (input.isAtBottom) return 0
  // liveMessages 在运行收尾时会清空；用户仍停在历史位置时保留已累计数量。
  if (input.eventCount < input.previousEventCount) return input.pendingEventCount
  return input.pendingEventCount + Math.max(0, input.eventCount - input.previousEventCount)
}

export function getRuntimeNavigationScrollTarget(
  key: string,
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
): number | undefined {
  const max = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
  const page = metrics.clientHeight * 0.9
  const target = key === 'ArrowUp' ? metrics.scrollTop - 48
    : key === 'ArrowDown' ? metrics.scrollTop + 48
      : key === 'PageUp' ? metrics.scrollTop - page
        : key === 'PageDown' ? metrics.scrollTop + page
          : key === 'Home' ? 0
            : key === 'End' ? max
              : undefined
  return target === undefined ? undefined : Math.max(0, Math.min(max, target))
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function motionSafeScrollBehavior(reducedMotion = prefersReducedMotion()): ScrollBehavior {
  return reducedMotion ? 'auto' : 'smooth'
}

export function motionSafeStickBehavior(reducedMotion = prefersReducedMotion()): 'instant' | 'smooth' {
  return reducedMotion ? 'instant' : 'smooth'
}
