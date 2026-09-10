import type { McpRemoteProviderKind, RemoteProviderCapabilities, ProviderGuideStep, ProviderBinaryDescriptor } from '../types/mcp-transport'
export interface ProviderDefinition { kind: McpRemoteProviderKind; name: string; use: 'stable' | 'test' | 'external' | 'experimental'; capabilities: RemoteProviderCapabilities; priceUrl: string; steps: ProviderGuideStep[]; controls: { binary?: ProviderBinaryDescriptor; auth: 'none' | 'secret' | 'system-or-secret'; hostname: 'none' | 'fixed' | 'auto-or-fixed' } }
const cap = (stableUrl: boolean, requiresAccount: boolean, requiresDomain: boolean, verification: RemoteProviderCapabilities['verification'], managedProcess = true): RemoteProviderCapabilities => ({ stableUrl, requiresAccount, requiresDomain, verification, managedProcess, freeTier: 'plan-dependent', supportsExternalManagement: !managedProcess, experimental: verification === 'experimental' })
const definitions: Omit<ProviderDefinition, 'controls'>[] = [
  { kind: 'cloudflare-quick', name: 'Cloudflare Quick', use: 'test', capabilities: { ...cap(false, false, false, 'verified'), freeTier: 'yes' }, priceUrl: 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/', steps: [
    { id: 'binary', title: '准备 cloudflared', description: '免费临时测试，通常无需账号或域名。选择已下载的官方程序或从 PATH 检测。', action: { kind: 'open-url', url: 'https://github.com/cloudflare/cloudflared/releases' } },
    { id: 'start', title: '生成临时地址', description: '启动并等待公网检查通过。每次重新连接地址可能变化，不适合长期自动恢复。', action: { kind: 'start' } },
  ] },
  { kind: 'cloudflare-named', name: 'Cloudflare Named', use: 'stable', capabilities: cap(true, true, true, 'not-tested'), priceUrl: 'https://developers.cloudflare.com/tunnel/', steps: [
    { id: 'account', title: '准备账号与域名', description: 'Tunnel 有免费计划；需要接入 Cloudflare 的自有域名，域名可能产生费用。', action: { kind: 'open-url', url: 'https://dash.cloudflare.com/' } },
    { id: 'binary', title: '检测 cloudflared', description: '选择已下载程序，或从 PATH 检测。', action: { kind: 'detect-executable' } },
    { id: 'token', title: '创建 Tunnel 并保存 Token', description: '在 Cloudflare 创建 remotely-managed Tunnel，只把 Tunnel Token 粘贴到下方密码框。', action: { kind: 'save-secret' } },
    { id: 'origin', title: '设置 Published Application', description: '把固定 HTTPS 域名转发到下面显示的 localhost 地址，然后启动并检查。', action: { kind: 'start' } },
  ] },
  { kind: 'tailscale-funnel', name: 'Tailscale Funnel', use: 'stable', capabilities: cap(true, true, false, 'beta'), priceUrl: 'https://tailscale.com/pricing', steps: [
    { id: 'install', title: '安装并登录 Tailscale', description: '个人使用可选免费计划，无需自有域名；Funnel 为 Beta。', action: { kind: 'open-url', url: 'https://tailscale.com/download' } },
    { id: 'permissions', title: '启用 MagicDNS、HTTPS 与 Funnel 权限', description: '固定 ts.net 地址。公网支持 443/8443/10000；本版管理 443，已有其他映射时拒绝覆盖。', action: { kind: 'open-url', url: 'https://tailscale.com/docs/features/tailscale-funnel' } },
    { id: 'detect', title: '检测设备登录状态', description: '启动前校验当前 CLI 帮助与 tailscale status。启动按钮将为本次 Proma 连接开启 Funnel，停止时仅结束自己的进程。', action: { kind: 'detect-executable' } },
  ] },
  { kind: 'ngrok', name: 'ngrok', use: 'stable', capabilities: cap(true, true, false, 'not-tested'), priceUrl: 'https://ngrok.com/docs/pricing-limits/free-plan-limits', steps: [
    { id: 'account', title: '准备 ngrok 账号与程序', description: '免费档可用于轻量使用，有流量和请求额度；可使用账号分配的固定开发域名。', action: { kind: 'open-url', url: 'https://dashboard.ngrok.com/signup' } },
    { id: 'token', title: '准备独立 Credential', description: '推荐 PROMA 独立配置与加密 Credential。新 Token 不会自动创建新的公网 Domain；云端认证在启动后验证。', action: { kind: 'open-url', url: 'https://dashboard.ngrok.com/get-started/your-authtoken' } },
    { id: 'domain', title: '填写 PROMA 专用 Domain', description: '使用可供 PROMA 独占的固定 HTTPS 地址，账号额度以官方页面为准。未完成真实 ChatGPT Gate 前不标记已验证推荐。', action: { kind: 'start' } },
  ] },
  { kind: 'external-https', name: 'External HTTPS', use: 'external', capabilities: cap(true, false, false, 'not-tested', false), priceUrl: 'https://modelcontextprotocol.io/docs/develop/connect-remote-servers', steps: [
    { id: 'origin', title: '填写已有 HTTPS 地址', description: '费用取决于你使用的服务。Proma 不启动 Tunnel 进程；请将公网 origin 反向代理到下面的 localhost 地址。' },
    { id: 'probe', title: '检查公网 MCP', description: '保留完整请求路径、方法和响应；不使用自签名或关闭 TLS 校验。', action: { kind: 'probe' } },
  ] },
  { kind: 'openai-secure', name: 'OpenAI Secure Tunnel', use: 'experimental', capabilities: cap(false, true, false, 'experimental'), priceUrl: 'https://platform.openai.com/', steps: [
    { id: 'setup', title: '实验性 OpenAI 接入', description: '选择 full tunnel-client，填写 Tunnel ID 并保存 Runtime Key。仍使用统一 Remote Ingress；Hosted 工具扫描存在上游风险。', action: { kind: 'detect-executable' } },
  ] },
]
export const REMOTE_PROVIDERS: ProviderDefinition[] = definitions.map((provider) => ({ ...provider, controls: {
  binary: provider.capabilities.managedProcess ? {
    displayName: provider.kind.startsWith('cloudflare') ? 'cloudflared' : provider.kind === 'ngrok' ? 'ngrok' : provider.kind === 'tailscale-funnel' ? 'Tailscale CLI' : '完整 tunnel-client',
    command: provider.kind.startsWith('cloudflare') ? 'cloudflared' : provider.kind === 'ngrok' ? 'ngrok' : provider.kind === 'tailscale-funnel' ? 'tailscale' : 'tunnel-client',
    expectedFiles: provider.kind.startsWith('cloudflare') ? ['cloudflared.exe', 'cloudflared'] : provider.kind === 'ngrok' ? ['ngrok.exe', 'ngrok'] : provider.kind === 'tailscale-funnel' ? ['tailscale.exe', 'tailscale'] : ['tunnel-client.exe', 'tunnel-client'],
    required: true, allowPath: true, allowCustomPath: true,
    downloadUrl: provider.kind.startsWith('cloudflare') ? 'https://github.com/cloudflare/cloudflared/releases' : provider.kind === 'ngrok' ? 'https://ngrok.com/download' : provider.kind === 'tailscale-funnel' ? 'https://tailscale.com/download' : undefined,
  } : undefined,
  auth: provider.kind === 'ngrok' ? 'system-or-secret' : ['cloudflare-named', 'openai-secure'].includes(provider.kind) ? 'secret' : 'none',
  hostname: provider.kind === 'ngrok' ? 'auto-or-fixed' : ['cloudflare-named', 'external-https'].includes(provider.kind) ? 'fixed' : 'none',
} }))
