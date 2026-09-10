import type { McpTransportKind, McpTransportStatus, McpTransportDiagnostic } from '@proma/shared'
export interface McpTransportProvider {
  readonly kind: McpTransportKind
  preflight(): Promise<McpTransportStatus>
  start(): Promise<McpTransportStatus>
  stop(): Promise<void>
  getStatus(): McpTransportStatus
  diagnose(): Promise<McpTransportDiagnostic>
  clearLogs?(): void
}
