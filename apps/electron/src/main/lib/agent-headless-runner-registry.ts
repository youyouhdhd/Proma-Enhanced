/**
 * Agent headless runner 注册表
 *
 * 用于主进程内置工具在不直接 import agent-service.ts 的情况下启动/停止真实 Agent 会话，
 * 避免 AgentOrchestrator 与 agent-service 形成难以维护的循环依赖。
 */

import type {
  AgentExternalRunSource,
  AgentMessage,
  AgentSendInput,
} from '@proma/shared'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
export interface HeadlessRunExtensions {
  piCustomTools?: ToolDefinition[]
  /** 受限只读工具；与 actionTools 二选一，由主进程可信调用方注入。 */
  analysisTools?: ToolDefinition[]
  /** 受限动作工具；仅通过已授权的 PROMA Agent Action 任务注入。 */
  actionTools?: ToolDefinition[]
}

export interface HeadlessAgentRunCallbacks {
  onError: (error: string) => void
  onComplete: (messages?: AgentMessage[], outcome?: { stoppedByUser?: boolean }) => void
  onTitleUpdated: (title: string) => void
  source?: AgentExternalRunSource
  /** 发起此次 headless 运行的可见会话，用于将事件路由回其 renderer。 */
  originSessionId?: string
}

export type HeadlessAgentRunner = (
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
  extensions?: HeadlessRunExtensions,
) => Promise<void>

export type AgentStopper = (sessionId: string) => void

let headlessRunner: HeadlessAgentRunner | null = null
let agentStopper: AgentStopper | null = null

export function setHeadlessAgentRunner(runner: HeadlessAgentRunner): void {
  headlessRunner = runner
}

export function setAgentStopper(stopper: AgentStopper): void {
  agentStopper = stopper
}

export async function runRegisteredHeadlessAgent(
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
  extensions?: HeadlessRunExtensions,
): Promise<void> {
  if (!headlessRunner) {
    throw new Error('Agent headless runner 尚未初始化')
  }
  await headlessRunner(input, callbacks, extensions)
}

export function stopRegisteredAgent(sessionId: string): void {
  if (!agentStopper) {
    throw new Error('Agent stopper 尚未初始化')
  }
  agentStopper(sessionId)
}
