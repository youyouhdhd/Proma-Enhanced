export type McpTransportKind = 'local' | 'cloudflare-quick' | 'cloudflare-named' | 'openai-secure'
export interface PromaRemoteAccessConfig {
  mode: McpTransportKind
  autoStart: boolean
  publicIngress: { port: number; profile: 'public-readonly'; workspaceIds: string[] }
  cloudflare: { executableMode: 'system-path' | 'custom-path'; customPath?: string; hostname?: string }
  openai: { controlPlaneProxy?: string }
}
export interface McpTransportStatus {
  kind: McpTransportKind
  phase: 'stopped' | 'preflight' | 'starting' | 'ready' | 'error'
  endpoint?: { localUrl: string; publicUrl?: string; connectorUrl?: string }
  errorCode?: string
  errorMessage?: string
  executableVersion?: string
  probe?: { modern: boolean; toolCount: number; workspaceList: boolean }
  tokenConfigured?: boolean
  secretConfigured?: boolean
  experimental?: boolean
  requests?: Array<{ at: number; method: string; rpcMethod?: string; status: number; path: '/mcp/<redacted>'; probe: boolean }>
}
export interface McpTransportDiagnostic { status: McpTransportStatus; checks: Array<{ name: string; ok: boolean; detail: string }> }
export const MCP_TRANSPORT_IPC = {
  GET: 'mcp-transport:get', SAVE: 'mcp-transport:save', START: 'mcp-transport:start', STOP: 'mcp-transport:stop',
  DIAGNOSE: 'mcp-transport:diagnose', PICK: 'mcp-transport:pick', COPY: 'mcp-transport:copy',
  SAVE_TOKEN: 'mcp-transport:save-token', ROTATE_SECRET: 'mcp-transport:rotate-secret',
} as const
