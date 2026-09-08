/** V9 文档提供的真实安全请求形状；不含身份/密钥。UA 单独用于官方源码对应的合成归因测试。 */
export const tunnelOAuthProbe = [
  { method: 'POST', path: '/mcp', headers: { accept: 'application/json' }, body: '', status: 400 },
  { method: 'GET', path: '/mcp', headers: {}, status: 405 },
  { method: 'GET', path: '/.well-known/oauth-protected-resource/mcp', headers: {}, status: 404 },
  { method: 'GET', path: '/.well-known/oauth-protected-resource', headers: {}, status: 404 },
] as const
