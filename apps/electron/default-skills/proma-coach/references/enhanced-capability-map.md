# Proma Enhanced Fork 能力地图

本参考供 `proma-coach` 在用户询问 Enhanced 功能、能力来源、跨项目复用、ChatGPT Connector、远程连接、模型归因或长运行体验时按需读取。普通知识维护摩擦不需要加载。

目标是帮助用户选对入口、理解权限和完成排障。它不是 Release Notes，也不记录协议版本、IPC 名称或内部实现历史。

按问题搜索：`QuickAsk`、`requested/executed`、`Global Registry`、`Effective Inspector`、`workspace_list`、`Direct Tool`、`Agent Action`、`远程连接方式`、`常见诊断路径`、`安全不变量`。

## 快速路由

| 用户目标 | 优先建议 | 关键边界 |
|---|---|---|
| 临时问一个不应影响当前会话的问题 | QuickAsk | 与当前 Chat/Agent 上下文隔离 |
| 对话、查询或一次确定性工具调用 | Chat + 工具 | 工具必须在当前会话可见且已授权 |
| 项目调研、规划、多步修改与验证 | Agent | 受项目根、权限模式和工具策略约束 |
| 只给当前项目增加流程或服务 | Project Skill/MCP | 不自动扩大到其他项目 |
| 多个项目复用已验证的能力 | 显式 Promote 到 Global Registry | Global 化必须由用户决定 |
| 全局默认但允许项目例外 | Global Default + Project Overlay | Overlay 只保存差异 |
| 不允许下层放宽的安全底线 | Global Required | 仅用于真正不可绕过的约束 |
| 外部客户端执行明确的读写动作 | Connector Direct Tool | 每次调用重新检查项目和权限 |
| 外部客户端委派模型完成多步任务 | PROMA Agent Delegation | ChatGPT 不能代替本地审批 |

## 交互模式

### QuickAsk

- 适合短问题、临时解释和不希望污染当前会话的旁路咨询。
- 可独立选择模型和推理档位。
- 不继承当前 Agent 的完整会话上下文；需要项目连续工作时不要使用。

### Chat

- 适合对话、内容生成和确定性的 Function Call。
- 调 API、查数据或调用已有服务时，优先使用可见工具，不为一次调用创建 Skill。

### Agent

- 适合读取项目、形成计划、多步修改、运行验证和维护任务状态。
- Project Instructions、Global Instructions、Skills、MCP 和工具策略会在运行前解析为有效能力。

## 模型、渠道与授权

### 自建渠道推理档位

- OpenAI 兼容渠道可以声明推理档位并映射到实际请求参数。
- 当前会话选择表示请求偏好；渠道能力不支持时要显示真实限制，不伪造档位。

### requested 与 executed

- `requested` 是会话或渠道选择的偏好。
- `executed` 是该轮实际完成推理的模型；历史消息、会话预览、统计和飞书终态以它为准。
- fallback 后两者可以不同；切换当前模型不能改写旧轮次。

### Codex OAuth

- 登录采用显式会话状态机；生成授权信息不等于自动打开浏览器。
- 打开浏览器、复制链接或提交回调属于用户明确动作。
- 不建议关闭 state 校验、并发会话守卫或把 Token 写入普通配置。

## Global Agent Capability Layer

### Global Registry

保存跨项目共享的：

- Skills；
- MCP Server 非敏感定义；
- Instructions；
- Default/Required 工具拒绝策略。

Skill Promote 会复制实体到全局目录；MCP Promote 只复制非敏感定义，Header/env 凭据留在主进程 Keychain。

### Project Overlay

- 项目只记录是否继承 Global Default，以及相对 Global 的启用、禁用和项目附加规则。
- 项目原有 Skills/MCP 仍属于项目；Promote 后通过 Overlay 禁用原项目副本并启用 Global ID。
- 移除 Global 条目会清理相关引用，使原项目能力恢复生效；不会顺带删除 Skill 实体或 Keychain 凭据。

### Required 与 Default

- Default 可以被 Project、Session 或单轮覆盖。
- Required 在所有 Overlay 后再次执行，不能被下层关闭或用 allow 放宽。
- 工具策略采用 Deny-Wins；Required 拒绝始终保留。

### Effective Inspector

排障时优先检查：

- 来源：Global Required、Global Default、Project、Session、Turn；
- 是否 Required；
- 状态：Ready、Disabled、Missing、Error；
- `effectiveHash` 是否随有效配置变化；
- 最终禁止工具摘要。

空 Global Registry 与原 Workspace 加载行为等价。关闭全局解析开关会立即回到旧 Workspace 行为，不删除配置。

## ChatGPT Connector 与 MCP Sharing

### 能力发现

- MCP 服务级 instructions 会说明工具使用顺序和权限预检要求。
- 工具 metadata 描述只读、破坏性、幂等和开放网络等属性。
- `workspace_list` 返回当前授权项目和实时有效权限；在否定读写、Shell 或 Agent 权限前必须先调用它。
- 服务说明或工具定义变化会改变 Discovery fingerprint，需要 ChatGPT Scan Tools/Refresh；项目内容和实时权限变化通常不需要更换 Connector URL。

### Direct Tool

- 适合路径明确、结果可确定的文件、搜索、Git、写入和 Shell 操作。
- 写入与 Shell 默认关闭，必须同时通过全局工具开关、项目权限、Scope、路径边界和逐调用复核。
- 多项目时显式使用 `workspace_id`，不要依赖“当前项目”。

### Agent Analysis 与 Agent Action

- Analysis 用模型完成异步只读分析。
- Action 用受限 PROMA Agent 完成用户明确要求的修改或多步骤动作。
- Agent Action 可按本地策略直接运行或进入 `waiting_approval`；ChatGPT 不能替用户批准。
- 任务固定到一个 Workspace，撤权、取消、并发、队列和速率限制持续生效。

## 远程连接方式

| 方式 | 适用场景 | 主要提醒 |
|---|---|---|
| Local Only | 本机客户端或本地诊断 | 不创建公网入口 |
| Cloudflare Quick | 临时联调 | URL 会变化，必须通过公网 MCP 探测才算 Ready |
| Cloudflare Named | 稳定域名 | 需要正确的 Tunnel/域名配置 |
| Tailscale Funnel | 已使用 Tailscale 的稳定入口 | 启动前检查登录、HTTPS/Funnel 权限和端口占用 |
| ngrok | 固定开发域名或临时地址 | 区分 PROMA Managed、System、External Existing 所有权 |
| External HTTPS | 已有反向代理或公网服务 | Proma 不启动网络进程，只探测现有地址 |
| OpenAI Secure Tunnel | 实验性兼容路径 | Doctor 与 readiness 只证明对应链路，不代表 ChatGPT 已完成工具调用 |

Ready 必须来自真实 MCP 探测，不能用“进程仍存活”代替。Degraded 表示最近诊断失败但已有连接不应被轻率终止。

## 常见诊断路径

### Skill 或 MCP 没有生效

1. 查看 Effective Inspector 的来源和状态。
2. Disabled：检查 Project Overlay 或全局默认继承。
3. Missing：检查 Skill 实体/SKILL.md 或 MCP 引用是否存在。
4. Error：修复实体或定义，不创建同名副本掩盖问题。
5. Ready 但 Skill 未触发：再检查 description 与用户表达是否匹配。

### 想让一个能力跨项目使用

1. 先确认能力在原项目已验证。
2. 确认确实有两个以上项目需要，而不是一次性需求。
3. 从迁移候选显式 Promote。
4. 在第二个项目检查来源为 Global Default/Required 且状态 Ready。
5. 同名但定义不同的 MCP 只报告冲突，不自动覆盖。

### ChatGPT 声称没有 Agent 权限

1. 调用 `workspace_list`，核对目标项目、Agent 模式和 readiness。
2. 检查 `proma_action_start` 是否在工具列表可见。
3. 若配置刚改变，执行 Scan Tools/Refresh。
4. `waiting_approval` 时转到 Proma 本地处理，不在 ChatGPT 侧伪造批准。

### Connector 无法连接

1. 区分请求未到达、Discovery、Transport、Auth、权限和工具调用失败。
2. 查看最近请求来源；内部 probe、本地 Client 和真实 Connector RPC 不能混为一谈。
3. 检查 Provider readiness、脱敏日志和公网 MCP 探测。
4. 不因为 Local MCP 成功就宣称公网链路成功。

### 模型显示与当前选择不同

1. 检查该轮 requested/executed/fallback 快照。
2. 已完成历史以 executed 为事实来源。
3. 没有 executed 证据时明确未知，不从当前 Binding 推测。

### 长任务期间阅读被打断

- 用户向上滚动后停止自动跟随，并显示“最新 · N”。
- 点击“最新”或按 End 回到底部并清零计数。
- ScrollMinimap 支持 Home、End、方向键和 Page Up/Page Down。
- Reduced Motion 环境不使用平滑动画。

## 安全不变量

- 不自动 Promote，不自动合并同名但不同定义的能力。
- 不绕过 Global Required、Deny-Wins、项目权限、路径与 symlink 边界。
- 不把 Token、Authorization Header、环境变量值或 Connector Secret 写入 Skill、提示词、普通 JSON、日志或诊断导出。
- 不把 Proma 内部 Agent 能力当成 ChatGPT Connector 已获得的权限。
- 不把 ChatGPT 发起任务当成本地审批已经完成。
- 不用当前模型 Binding 改写历史 executed model。
- 不把模拟探测、Local Client 成功或进程存活描述为真实公网端到端成功。

## 更新与发布

- Enhanced Fork 使用独立版本线和 Release 来源；用户下载、更新历史和 Latest 判断应指向 Enhanced 仓库。
- 上游同步只代表取得官方主分支更新，不会自动包含 Fork 的 Connector、QuickAsk、模型和全局能力增强。
- 询问具体版本变化时读取当前 Release Notes；本参考只维护稳定心智模型，不复制版本时间线。

## 维护来源

更新本参考时优先核对：

- 仓库根 `README.md` 的 Fork 差异摘要；
- `docs/fork-maintenance.md` 的真实分叉边界；
- 当前 `release-notes/`；
- Agent Capability、MCP Sharing、MCP Transport 和 QuickAsk 的实际源码与测试。
