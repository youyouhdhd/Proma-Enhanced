interface PendingInteraction {
  requestId: string
  sessionId: string
}

/** 实时事件与重载快照共用去重规则，迟到快照不能复活已解决请求。 */
export function queuePendingInteraction<T extends PendingInteraction>(
  previous: Map<string, readonly T[]>, request: T, resolved: ReadonlySet<string>,
): Map<string, readonly T[]> {
  if (resolved.has(request.requestId)) return previous
  const current = previous.get(request.sessionId) ?? []
  if (current.some((item) => item.requestId === request.requestId)) return previous
  return new Map(previous).set(request.sessionId, [...current, request])
}

export function resolvePendingInteraction<T extends PendingInteraction>(
  previous: Map<string, readonly T[]>, requestId: string, resolved: Set<string>,
): Map<string, readonly T[]> {
  resolved.add(requestId)
  if (resolved.size > 256) resolved.delete(resolved.values().next().value!)
  let changed = false
  const next = new Map(previous)
  for (const [sessionId, requests] of previous) {
    const remaining = requests.filter((item) => item.requestId !== requestId)
    if (remaining.length === requests.length) continue
    changed = true
    if (remaining.length) next.set(sessionId, remaining)
    else next.delete(sessionId)
  }
  return changed ? next : previous
}
