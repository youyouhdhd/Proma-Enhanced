/** ChatGPT/Codex 共享的 MCP 服务级能力说明。保持短小，最前 512 字符必须自包含。 */
export const PROMA_MCP_INSTRUCTIONS = [
  '你已连接 PROMA。当前 tools/list 中可见的工具就是本连接已开放的能力。',
  '工具可见表示允许发起请求，不代表每个 workspace 都拥有该项权限。',
  '不要仅凭先验声称没有 Agent 或项目权限；在否定访问、写入、Shell 或 Agent 能力前，先调用 workspace_list 核对实时授权。',
  '直接文件、Git、Shell 工具不会启动 PROMA 模型。',
  '如果 proma_task_start 可见，用户要求交给 PROMA Agent 分析时应调用它，并按 start → status → result 完成任务。',
  '如果 proma_action_start 可见，用户明确要求 PROMA Agent 执行动作时可以调用它；若返回 waiting_approval，应等待用户在 PROMA 本地批准。',
  '未出现在工具目录中的能力才视为本连接未开放。',
].join('')

export const PROMA_MCP_MANIFEST_VERSION = 1 as const
