/**
 * OpenAI Tunnel Client 类型定义（第三轮）
 *
 * 统一收敛 CLI 交互契约：参数构造只在 Adapter、解析只在 Adapter、
 * 进程管理只在 Manager/Service。CLI 具体参数不散落到业务代码。
 */

import type { PromaMcpTunnelDetection } from '@proma/shared'

/** 运行 tunnel-client 所需的运行时配置（全部由 PROMA 自动产生，用户不需要理解） */
export interface TunnelRuntimeConfig {
  tunnelId: string
  /** 本地 PROMA MCP endpoint，如 http://127.0.0.1:8787/mcp */
  mcpServerUrl: string
  /** 健康检查监听地址（PROMA 随机端口），如 127.0.0.1:0 */
  healthListenAddr: string
  /** tunnel-client 把实际健康检查 URL 写入该文件，PROMA 轮询读取 */
  healthUrlFile: string
}

/** Doctor 原始结果（Adapter 解析前的中间形态） */
export interface TunnelDoctorRaw {
  exitCode?: number
  stdout: string
  stderr: string
}

/** Doctor 结构化结果（V5：三态诊断，与 shared 契约一致） */
export type TunnelDoctorResult = import('@proma/shared').PromaMcpTunnelDoctorResult

export type TunnelClientSpawnSync = (
  executable: string,
  args: string[],
  options: { encoding: 'utf8'; timeout?: number; windowsHide: boolean; env?: Record<string, string | undefined> },
) => { status: number | null; stdout?: string; stderr?: string; error?: Error & { code?: string } }

export type TunnelClientSpawn = (
  executable: string,
  args: string[],
  options: { stdio: ['ignore', 'pipe', 'pipe']; windowsHide: boolean; env: Record<string, string | undefined> },
) => import('node:child_process').ChildProcess & { pid?: number }

export interface TunnelManagerDeps {
  spawnSync: TunnelClientSpawnSync
  exists(path: string): boolean
  isFile(path: string): boolean
  readdir(path: string): string[]
  configDir(): string
}

/** 检测结果统一别名（与 shared 保持一致） */
export type TunnelClientDetection = PromaMcpTunnelDetection
