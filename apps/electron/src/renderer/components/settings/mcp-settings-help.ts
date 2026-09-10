export interface SettingHelpContent {
  title: string; summary: string; defaultValue?: string; shouldChange?: string
  impact?: string[]; security?: string[]; learnMoreUrl?: string
}
export const MCP_SETTINGS_HELP = {
  'remote-ingress-port': { title: '远程连接本机端口', summary: '公网 Provider 将 HTTPS 请求转发到 PROMA 的本机端口。ChatGPT → HTTPS :443 → ngrok → 127.0.0.1:8787 → PROMA。该本机端口不会出现在 ChatGPT Server URL 中。', defaultValue: '8787（保留现有配置）', shouldChange: '通常无需修改；端口被占用或已有反向代理要求时再改。', impact: ['修改需要重启 Remote Ingress，固定 Domain 通常不变。'] },
  'local-mcp-service': { title: '本机 MCP 服务', summary: '供能直接访问 localhost 的 MCP Inspector、开发工具和自动化脚本使用。本机 MCP Client → 127.0.0.1:<auto> → PROMA。它与 ChatGPT 公网 Provider 使用的入口不同。', defaultValue: '自动端口', shouldChange: '仅通过 ngrok 连接 ChatGPT 时通常无需修改。' },
  'ngrok-managed-profile': { title: 'PROMA 独立环境', summary: 'PROMA 管理独立配置、加密 Credential 和自己的子进程，使用独占的公网 Domain。其它项目的系统配置和进程保持各自管理。', security: ['配置文件不保存 Token 或 Connector Secret；不会修改系统 ngrok.yml。'] },
  'ngrok-credential': { title: 'PROMA Credential', summary: '新 Token 只隔离认证，不会自动创建新的 Domain，也不会消除相同 Domain 的冲突。可使用同账号的新 Credential 或其它账号 Credential。', security: ['使用系统安全存储加密保存，仅传入 PROMA 的 ngrok 子进程。'], learnMoreUrl: 'https://dashboard.ngrok.com/get-started/your-authtoken' },
  'ngrok-domain': { title: 'PROMA 专用公网地址', summary: '这个 Domain 应专门给 PROMA 使用。其它 Agent 绑定到不同服务时，PROMA 无法安全地同时绑定它。', impact: ['账号需要有可供 PROMA 独占的 Endpoint；具体额度以官方页面为准。', '项目增删不会改变 Domain；更换 Domain 后需更新 ChatGPT 地址。'], learnMoreUrl: 'https://dashboard.ngrok.com/domains' },
  'ngrok-inspector': { title: 'ngrok Inspector', summary: '显示 ngrok 日志报告的实际本机诊断地址，端口可能变化。Inspector 不参与 Connector Ready 判定。', security: ['可能保留请求头及内容，只在可信本机使用。'] },
  'agent-max-concurrent': { title: '最大并发 Agent 任务', summary: '只控制“交给 PROMA Agent”的异步任务，不限制 read_file、write_file、shell_execute 等 Direct MCP Tools。', defaultValue: '1；建议 1–2，最多 4', impact: ['提高会增加模型并发、CPU、磁盘 I/O 和 API 费用。'] },
  'agent-max-queued': { title: '最大等待 Agent 任务', summary: 'Agent 并发达到上限后，最多缓存多少任务。0 表示不排队，并发满后立即返回 BUSY。仅影响异步 Agent，不限制 Direct MCP Tools。', defaultValue: '3；允许 0–20' },
  'connector-secret': { title: 'Connector Secret', summary: '一个 Domain、一个 Secret、一个 ChatGPT App 可以访问多个已授权项目。正常保存、重连和项目增删不轮换 Secret。', security: ['完整 Server URL 是访问凭据。泄露时立即撤销远程访问，旧 URL 失效。外部 ngrok 进程仍由其所有者管理。'] },
} satisfies Record<string, SettingHelpContent>
export type McpHelpTopic = keyof typeof MCP_SETTINGS_HELP
