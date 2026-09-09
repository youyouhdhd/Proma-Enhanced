export type McpRemoteProviderKind = 'cloudflare-quick' | 'cloudflare-named' | 'tailscale-funnel' | 'ngrok' | 'external-https' | 'openai-secure'
export type McpTransportKind = McpRemoteProviderKind
export type ApplyImpact = 'none' | 'hot' | 'ingress-restart' | 'provider-restart' | 'connector-url-changed'
export interface RemoteProviderSettings { executablePath?: string; hostname?: string; controlPlaneProxy?: string; tunnelId?: string }
export interface PromaRemoteAccessConfig {
  version: 2
  enabled: boolean
  provider?: McpRemoteProviderKind
  autoStart: boolean
  publicIngress: { port: number; scopeMode: 'inherit' | 'custom'; workspaceIds: string[] }
  providers: Partial<Record<McpRemoteProviderKind, RemoteProviderSettings>>
}
export interface McpTransportStatus {
  kind?: McpTransportKind
  phase: 'stopped' | 'preflight' | 'starting' | 'ready' | 'degraded' | 'error'
  endpoint?: { localUrl: string; publicUrl?: string; connectorUrl?: string }
  errorCode?: string
  errorMessage?: string
  executableVersion?: string
  probe?: { modern: boolean; toolCount: number; workspaceList: boolean }
  tokenConfigured?: boolean
  secretConfigured?: boolean
  experimental?: boolean
  restartRequired?: boolean
  applyImpact?: ApplyImpact
  toolSchemaFingerprint?: string
  confirmedToolSchemaFingerprint?: string
  connectorUrlFingerprint?: string
  urlChanged?: boolean
  stableUrl?: boolean
  pid?: number
  requests?: Array<{ at: number; method: string; rpcMethod?: string; status: number; path: '/mcp/<redacted>'; probe: boolean }>
}
export interface McpTransportDiagnostic { status: McpTransportStatus; checks: Array<{ name: string; ok: boolean; detail: string }> }
export const MCP_TRANSPORT_IPC = {
  GET: 'mcp-transport:get', SAVE: 'mcp-transport:save', START: 'mcp-transport:start', STOP: 'mcp-transport:stop',
  DIAGNOSE: 'mcp-transport:diagnose', PICK: 'mcp-transport:pick', COPY: 'mcp-transport:copy',
  SAVE_TOKEN: 'mcp-transport:save-token', ROTATE_SECRET: 'mcp-transport:rotate-secret',
  CONFIG_CHANGED: 'mcp-remote-config:changed', STATUS_CHANGED: 'mcp-remote-status:changed', DETECT: 'mcp-transport:detect',
  CONFIRM_SCHEMA: 'mcp-transport:confirm-schema',
} as const
export interface RemoteProviderCapabilities {
  stableUrl: boolean; requiresAccount: boolean; requiresDomain: boolean; freeTier: 'yes' | 'plan-dependent'
  managedProcess: boolean; supportsExternalManagement: boolean; experimental: boolean
  verification: 'verified' | 'beta' | 'experimental' | 'not-tested'
}
export interface ProviderGuideStep { id: string; title: string; description: string; action?: { kind: 'open-url' | 'detect-executable' | 'pick-file' | 'save-secret' | 'start' | 'probe'; url?: string } }
