import { AGENT_RUNTIME_METHODS } from '@proma/shared'

const DEFAULT_PARENT_REQUEST_TIMEOUT_MS = 120_000

/**
 * Utility Process 请求主进程的等待时间。
 * 授权阶段可能等待用户选择/审批，只由回复或取消结束；其他能力仍检测故障超时。
 */
export function getParentRequestTimeoutMs(method: string): number | null {
  return method === AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL ? null : DEFAULT_PARENT_REQUEST_TIMEOUT_MS
}
