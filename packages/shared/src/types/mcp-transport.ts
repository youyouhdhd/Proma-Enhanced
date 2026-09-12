export type McpRemoteProviderKind = 'cloudflare-quick' | 'cloudflare-named' | 'tailscale-funnel' | 'ngrok' | 'external-https' | 'openai-secure'
export type McpTransportKind = McpRemoteProviderKind
export type ApplyImpact = 'none' | 'hot' | 'ingress-restart' | 'provider-restart' | 'connector-url-changed'
export interface ProviderLogEntry {
  at: number; provider: McpRemoteProviderKind
  source: 'system' | 'command' | 'stdout' | 'stderr' | 'probe' | 'mcp'
  level: 'debug' | 'info' | 'warn' | 'error'; text: string
}
export interface RemoteProviderSettings {
  mode?: 'proma-managed' | 'system' | 'external-existing'
  credentialMode?: 'proma-secret' | 'system-config'
  domainConfirmed?: boolean
  executablePath?: string; hostname?: string; controlPlaneProxy?: string; tunnelId?: string
  authSource?: 'system-config' | 'proma-secret'
  configSource?: 'default' | 'custom'; configPath?: string
  endpointMode?: 'fixed-domain' | 'auto-domain'
  webInspector?: 'default' | 'disabled'
}
export interface ProviderBinaryDescriptor {
  displayName: string; expectedFiles: string[]; command: string; required: boolean
  downloadUrl?: string; installGuideUrl?: string; allowPath: boolean; allowCustomPath: boolean
}
export interface ProviderBinaryDetection {
  ok: boolean; source?: 'path' | 'custom'; resolvedPath?: string; version?: string; detail: string
}
export interface NgrokConfigDetection {
  valid: boolean; source: 'system' | 'proma-managed' | 'custom'; path?: string; authConfigured?: boolean
}
export interface NgrokRuntimeState {
  mode: NonNullable<RemoteProviderSettings['mode']>
  ownership: 'proma-process' | 'existing-proma-endpoint' | 'external-conflict' | 'none'
  inspectorUrl?: string; config?: NgrokConfigDetection
  credentialSource?: 'proma-secret' | 'system-config' | 'external'
}
export interface PromaRemoteAccessConfig {
  version: 3
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
  probe?: { modern: boolean; toolCount: number; workspaceList: boolean; instructions?: boolean }
  tokenConfigured?: boolean
  secretConfigured?: boolean
  experimental?: boolean
  restartRequired?: boolean
  applyImpact?: ApplyImpact
  toolSchemaFingerprint?: string
  confirmedToolSchemaFingerprint?: string
  /** Discovery fingerprint 包含 instructions 与 tools/list metadata；旧字段保留兼容。 */
  discoveryManifestVersion?: number
  discoveryFingerprint?: string
  confirmedDiscoveryFingerprint?: string
  connectorUrlFingerprint?: string
  urlChanged?: boolean
  stableUrl?: boolean
  pid?: number
  binary?: ProviderBinaryDetection
  ngrok?: NgrokRuntimeState
  logs?: ProviderLogEntry[]
  requests?: Array<{ at: number; method: string; rpcMethod?: string; status: number; path: '/mcp/<redacted>'; probe: boolean; toolName?: string; workspaceId?: string; durationMs?: number; resultType?: 'response' | 'error' }>
}
export interface McpTransportDiagnostic { status: McpTransportStatus; checks: Array<{ name: string; ok: boolean; detail: string; level?: 'pass' | 'warn' | 'fail'; nextAction?: string }> }
export const MCP_TRANSPORT_IPC = {
  GET: 'mcp-transport:get', SAVE: 'mcp-transport:save', START: 'mcp-transport:start', STOP: 'mcp-transport:stop',
  DIAGNOSE: 'mcp-transport:diagnose', PICK: 'mcp-transport:pick', COPY: 'mcp-transport:copy',
  SAVE_TOKEN: 'mcp-transport:save-token', ROTATE_SECRET: 'mcp-transport:rotate-secret',
  CONFIG_CHANGED: 'mcp-remote-config:changed', STATUS_CHANGED: 'mcp-remote-status:changed', DETECT: 'mcp-transport:detect',
  CONFIRM_SCHEMA: 'mcp-transport:confirm-schema',
  PICK_CONFIG: 'mcp-transport:pick-config', CLEAR_LOGS: 'mcp-transport:clear-logs',
} as const
export interface RemoteProviderCapabilities {
  stableUrl: boolean; requiresAccount: boolean; requiresDomain: boolean; freeTier: 'yes' | 'plan-dependent'
  managedProcess: boolean; supportsExternalManagement: boolean; experimental: boolean
  verification: 'verified' | 'beta' | 'experimental' | 'not-tested'
}
export interface ProviderGuideStep { id: string; title: string; description: string; action?: { kind: 'open-url' | 'detect-executable' | 'pick-file' | 'save-secret' | 'start' | 'probe'; url?: string } }
