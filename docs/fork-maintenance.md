# Proma Fork 维护与上游同步指南

记录版本：0.1.9
最后核对：2026-09-11
适用对象：维护 `youyouhdhd/Proma-Enhanced` Fork（官方上游 `proma-ai/Proma`）的开发者

本文的目标是让维护者在 `proma-ai/Proma` 发布新版本后，能够先取得上游更新，再有边界地重放本 Fork 的定制功能。它记录当前仓库的真实分叉状态、定制提交和已知冲突区域；不把上游代码复制成第二份，也不建议直接在 `main` 上试错。

## 当前仓库状态

### 2026-09-11：v1.12.1 发布

v1.12.1 将上游同步后的开发线作为正式版本发布。版本包含 Pi 0.85.1、上游 35 个提交、V13 Managed ngrok 和运行时依赖来源修复；发布说明见 [v1.12.1](../release-notes/v1.12.1.md)。

- 产品代码基线：`492be976dbf983a7d000521d3ff89e690f6531cb`；`v1.12.1` 标签指向本次发布元数据提交。
- 上游合并提交：`f72fa19c1f4bf122fdbaf2e2340723f92f8dfb0b`，上游基线：`f99edbdb594407ab190b97ae073889c5d96637ab`。
- 应用版本 1.12.1，shared 0.7.0，根工作区 1.1.1；标签 `v1.12.1` 固定在该提交。
- 发布前验证：700 tests pass、typecheck、Electron build、Renderer 扫描、Windows 包内 runtime/native/MCP 冒烟通过。
- 旧 `.bun/node_modules` 不再参与默认运行时依赖来源解析；hoisted 版本选择有隔离回归测试。

### 2026-09-11：v1.12.0 上游同步开发基线

- 在发布 v1.11.0 后，合入 `upstream/main` 的 `f99edbdb594407ab190b97ae073889c5d96637ab`，共 35 个上游提交，对应上游应用 0.19.53。
- Fork 应用版本递增为 1.12.0，shared 0.7.0，根工作区 1.1.1；Pi runtime 0.85.1，Automation Skill 1.0.14。
- 10 个冲突文件分别处理：版本保持 Fork 版本线；Codex 授权保留会话状态机并并入 Copilot；模型注册保留自建推理档位；Agent 编排保留只读分析隔离；README 合并新版结构与 Fork 说明；Bun 锁文件按合并后的依赖重新生成。
- 上游新增缓存清理测试使用了 POSIX 专属失败条件，本次改为跨平台临时路径与 EACCES 故障注入，保留原有清理业务逻辑。
- 合入内容详见 [v1.12.0 开发记录](../release-notes/v1.12.0.md)。v1.12.1 发布后，v1.11.0 作为上一稳定版本保留，不移动历史标签。

### 2026-09-11：v1.11.0 发布

- v1.11.0 固定为用户已实测可用的 V13 版本：Managed ngrok 隔离、安全 Endpoint 复用、Provider 引导、统一设置帮助与零等待队列。
- 应用 1.11.0、shared 0.6.0、Bridge 13；发布说明见 [v1.11.0](../release-notes/v1.11.0.md)。
- 此标签已合入的上游基线为 `7a3721d7cfe6e107b58c79e27a43fa463dac21ee`。较新的 `f99edbdb594407ab190b97ae073889c5d96637ab` 在本版本发布后单独合并，避免改变实测发布基线。
- 上游同步必须保留 Fork 的 Pi runtime、显式项目指令边界、MCP 四层 IPC、safeStorage、权限撤销、Managed ngrok 所有权以及原有 QuickAsk/推理档位定制。

### 远端关系

| 名称 | 地址 | 用途 |
| --- | --- | --- |
| `origin` | `https://github.com/youyouhdhd/Proma-Enhanced.git` | 本 Fork，提交和发布目标 |
| `upstream` | `https://github.com/proma-ai/Proma.git` | 官方上游，只用于获取最新代码 |

本机已经配置了 `upstream` 远端。新克隆的副本需要手动执行：

~~~powershell
git remote add upstream https://github.com/proma-ai/Proma.git
git fetch upstream --prune
~~~

### 2026-08-29 合并前快照

- 本 Fork 的 v0.18.3 发布基线：`57e18e30`，tag `v0.18.3`，应用版本 `0.18.3`。
- 上游 `upstream/main`：`c261cbc5`，应用版本 `0.19.5`。
- `main` 与上游的共同基点：`92a635fa`（官方 v0.18.2）。
- 在这个 v0.18.3 比较快照中，相对共同基点上游新增 73 个提交，本 Fork 发布基线新增 1 个提交（本地构建指南、版本元数据和 Windows 测试修正）。本维护文档本身不属于上游产品定制差异。
- 本 Fork 的主要产品定制当时位于独立分支 `origin/feat/custom-model-reasoning`，提交为 `0a19e264`，尚未合并进 `main`。

该快照说明 Fork 不会自动获得上游功能，但可以在同步分支中合并 `upstream/main`，再重放定制提交。

### 2026-08-30 同步结果

- 已将上游 `c261cbc5`（官方 v0.19.5）合入同步分支，合并提交为 `d8dd43ed`。
- 合并前备份分支：`backup/main-before-upstream-v0.19.5-20260830`。
- 同步分支：`sync/upstream-v0.19.5-20260830`。
- 自建模型推理档位以 `0a19e264` 为行为规格适配到上游新架构，没有覆盖上游 Pi 0.84.4、reasoning profiles、终端、Vault、LiveMarkdown 和新版工作区布局。
- 集成版本：应用 `0.19.6`、shared `0.1.67`、core `0.2.18`、根项目 `0.1.3`。
- 定制适配继续覆盖 Chat 与 Agent 双路径、频道配置 UI、多窗口频道同步及 BDD 测试。
- Windows 打包在应用 `0.19.7` / 根项目 `0.1.4` 增加了 node-pty 预编译 Electron 冒烟验证；保留 Spectre 源码重编译，不再通过修改 gyp 降低安全选项。

### 2026-08-30 上游同步自动化

- 根项目 `0.1.5` 增加 `sync:upstream` 和 `verify:upstream` 入口。
- `sync:upstream` 默认只检查；`--apply` 会检查工作区、抓取 origin/upstream、创建备份分支和同步分支，再增量合并上游。
- `--apply --verify` 在无冲突合并后自动执行类型检查、全量测试和 Electron 构建；冲突或验证失败都会保留同步分支，不自动推送。
- 当前 `main` 已经包含定制实现，未来从 `main` 合并上游时不需要重复 cherry-pick `0a19e264`；该提交仅作为从零恢复定制的历史规格。

### 2026-09-06 状态快照（v0.19.26 上游同步）

- 本 Fork 的 `main`：合入上游 `7a3721d7`（官方 v0.19.26 之后的 main，共 21 个上游提交），应用版本 `1.0.0`（Fork 独立版本号起始，见「独立版本号策略」）。
- 本次合入的上游重点：Slack Bridge、GPT-6 Astra（Codex）、Gemini 3 思考深度（`thinkingLevel` 字段 + `ChatThinkingPopover`）、Brave/Tavily MCP 预设、移除教程功能链路、Pi runtime 升级 0.85.0（补丁文件随之重命名）。
- 与本 Fork 定制的合并策略：`thinkingLevel`（上游内置模型思考深度）与本 Fork 的 `reasoningLevel`（自建渠道声明档位）在 ChatSendInput / StreamRequestInput 中**并存**，openai-adapter 的 `reasoningEffort` 映射保留；ChatInput 工具栏同时保留 `ChatThinkingPopover` 与渠道档位 Select。
- 同步验证：typecheck 六包全绿、bun test 543 用例全过、Windows 打包通过。

### 2026-09-05 状态快照

- 本 Fork 的 `main`：`358c42e2`（应用版本 `0.19.25`），工作区干净，与 `origin/main` 同步。
- 最近一次上游合并：`8c1c8dbd` 合入官方 v0.19.23；随后以 `c037a122` 发布 v0.19.24。
- 上游 `upstream/main`：`e411c38f`（官方 v0.19.26），相对本 Fork 领先 11 个提交，**待下一次同步**。
- 本 Fork 相对上游独有 10 个已提交（含 2 个合并/发布提交与 8 个功能/修复/文档提交），工作区另有待提交的未标注代码块语言误判修复与 QuickAsk 临时提问功能，完整清单见下文「本 Fork 相对上游的全部独有提交」。
- 相对上游的完整文件差异已固化到本文「Fork 相对上游的完整文件差异」一节，同步前可用 `git diff --name-status upstream/main...HEAD` 重新核对。

#### 本 Fork 相对上游的全部独有提交（截至 2026-09-05）

| 提交 | 说明 | 性质 |
| --- | --- | --- |
| `57e18e30` | v0.18.3 发布准备：构建指南、README 版本修正、Windows 测试隔离修正 | 维护 |
| `c39eb693` | 建立本维护文档，记录 fork 定制与同步流程 | 文档 |
| `d8dd43ed` | 合并上游 v0.19.5 | 合并 |
| `60d9f9d3` | 自建模型推理档位适配上游 v0.19.5 新架构（行为规格源自 `0a19e264`） | 定制功能 |
| `96cba041` | Windows 打包前用 Electron 实际启动 PTY 验证 node-pty 预编译产物 | 构建修正 |
| `043adcf1` | `sync:upstream` / `verify:upstream` 自动化同步脚本 | 维护工具 |
| `92c24992` | llama.cpp 工具语法边界修复（详见下文定制记录） | 定制修复 |
| `8c1c8dbd` | 合并上游 v0.19.23 | 合并 |
| `c037a122` | 发布 v0.19.24 | 发布 |
| `358c42e2` | 新增 `scripts/build-win.ps1` 一键构建 Windows 安装包 | 构建工具 |

### Fork 相对上游的完整文件差异（2026-09-05）

以下清单来自 `git diff --name-status upstream/main...HEAD`，是同步上游时最需要人工复核的范围。上游合并后应重新执行该命令并对照本表，确认定制没有被覆盖、也没有把上游新文件误删：

| 类型 | 文件 | 归属 |
| --- | --- | --- |
| 新增 | `docs/build.md`、`docs/fork-maintenance.md`、`docs/llama-cpp-tool-grammar-limits.md`、`docs/qwen-lite-502-upstream-diagnosis.md` | Fork 文档 |
| 新增 | `scripts/build-win.ps1`、`scripts/sync-upstream.ts`、`scripts/sync-upstream.test.ts` | Fork 维护工具 |
| 新增 | `apps/electron/scripts/prepare-node-pty.ts`（含测试） | Windows node-pty 预编译验证 |
| 新增 | `apps/electron/src/main/lib/ask-user-tool-schema.ts`（含测试） | llama.cpp 语法边界修复 |
| 新增 | `packages/core/src/utils/grammar-bounds.ts`（含测试）、`packages/core/src/providers/openai-adapter.test.ts` | llama.cpp 语法边界修复 |
| 新增 | `packages/core/src/highlight/language-detector.test.ts`；修改 `packages/core/src/highlight/language-detector.ts` | 未标注代码块语言误判修复（2026-09-05） |
| 新增 | `packages/shared/src/types/quick-ask.ts`、`apps/electron/src/main/lib/quick-ask-store.ts`（含测试）、`apps/electron/src/main/lib/quick-ask-service.ts`、`apps/electron/src/renderer/atoms/quick-ask-atoms.ts`、`apps/electron/src/renderer/components/quick-ask/`、`apps/electron/src/renderer/lib/quick-ask-prefill.ts`（含测试）；修改 `ipc.ts`、`preload/index.ts`、`AppShell.tsx`、`ChatHeader/AgentHeader/ChatView/ChatMessages/ChatMessageItem`、`AgentView/AgentMessages/SDKMessageRenderer` | QuickAsk 临时提问浮窗（2026-09-05，待提交） |
| 新增 | `packages/shared/src/types/reasoning-profile.test.ts`、`apps/electron/src/renderer/lib/channel-model-reasoning.ts`（含测试）、`apps/electron/src/main/lib/adapters/pi-model-registry-reasoning.test.ts` | 自建模型推理档位 |
| 修改 | `packages/shared/src/types/reasoning-profile.ts`、`channel.ts`、`chat.ts` | 自建模型推理档位 |
| 修改 | `packages/core/src/providers/openai-adapter.ts`、`openai-responses-adapter.ts`（含测试）、`types.ts` | 推理档位 + 语法边界告警 |
| 修改 | `apps/electron/src/main/lib/adapters/pi-model-registry.ts`、`pi-agent-adapter.ts`、`pi-builtin-tools.ts` | 推理档位 + 语法边界修复 |
| 修改 | `apps/electron/src/main/lib/agent-orchestrator.ts`、`agent-collaboration-tools.ts`、`chat-service.ts`、`ipc.ts`、`planning-manager.test.ts` | 定制功能主进程 |
| 修改 | `apps/electron/src/preload/index.ts` | IPC bridge |
| 修改 | `apps/electron/src/renderer/atoms/chat-atoms.ts`、`components/agent/AgentView.tsx`、`app-shell/LeftSidebar.tsx`、`chat/ChatInput.tsx`、`chat/ChatView.tsx`、`settings/ChannelForm.tsx`、`hooks/useConversationSettings.ts`、`main.tsx` | 定制功能 UI |
| 修改 | `README.md`、`README.en.md`、根 `package.json`、`apps/electron/package.json`、`packages/core/package.json`、`bun.lock` | 版本与文档元数据 |
| 修改 | `apps/electron/src/main/lib/feishu-bridge.ts`、`apps/electron/src/main/lib/feishu/card-renderer-v2.ts`；新增根 `bunfig.toml` | 飞书卡片显示渠道名 + 安装布局固定（2026-09-05，待提交） |
| 修改 | `apps/electron/electron-builder.yml`（publish 不硬编码 owner，随检出仓库解析）；新增 `release-notes/v1.0.0.md` | 独立版本号与 CI 发布目标修正（2026-09-06） |
| 新增 | `packages/shared/src/types/mcp-server.ts`、`apps/electron/src/main/lib/local-tools/`（含测试）、`apps/electron/src/main/lib/mcp-server/`（含集成测试）、`apps/electron/src/renderer/components/settings/McpServerSettings.tsx`、`release-notes/v1.1.0.md`；修改 `AppSettings`、settings-service、ipc.ts、preload、BotHubSettings、main/index.ts | ChatGPT Web MCP Server + 本地工具注册表（2026-09-06，待提交） |

注意：`patches/` 目录（`@earendil-works/pi-ai@0.84.4.patch` 与 `node-pty@1.1.0.patch`）属于**上游自带**并通过根 `package.json` 的 `patchedDependencies` 生效，本 Fork 未做改动；同步时随上游自然更新，不要在 Fork 中单独修改这两个补丁。

## 本 Fork 的定制记录

### 第七轮优化（v1.6.0）：现代 MCP Discovery 兼容（server/discover）

- 请求观测升级：非敏感请求头（content-type/accept/mcp-protocol-version/mcp-method/mcp-name/user-agent）与 JSON-RPC error code 进入 trace；新增方法直方图 `PromaMcpMethodStats` 与诊断报告直方图/Discovery 管线四步 UI。
- 实现 `server/discover` 兼容 shim（`protocol/modern-handler.ts`）：无会话 POST 在 SDK v1 之前拦截并响应 protocolVersions/capabilities/serverInfo；未知方法仍 -32601；带 TODO(SPIKE-MCP-SDK-MODERN) 的升级路径。
- GET /mcp 无会话从 404 改为 405（Allow: POST）；带会话仍走 legacy SSE。
- Connector 结论新增 CASE B-DISCOVER / B-HANDSHAKE；`classifyConnectorConclusion` 抽为纯函数；Doctor 降噪（官方入口折叠）与 codex_plugin 降级为可选。
- 新增 `test:mcp-modern` 脚本（模拟 server/discover → tools/list → workspace_list）；集成测试 +5 项。

### 第六轮修复（v1.5.0）：凭据状态派生 + Doctor 对齐官方 Check + Local MCP Auth 转发

- Runtime Key 状态改为派生快照（safeStorage 为事实来源），保存后回读验证并实时推送；新增凭据健康三态（unreadable 不显示绿色）与清除入口。
- Doctor 改用 `127.0.0.1:0` 临时健康监听（修复 8080 冲突假失败）；Parser 对齐官方真实 Check ID，删除虚构期望项；`codex_plugin/ui SKIP` 不阻断 Connector；新增 `blockingFailures`。
- Local MCP 认证新增 `managed-bearer`（Secret 存 safeStorage，settings 不落明文，旧 bearer 自动迁移）；tunnel-client 经 `PROMA_MCP_AUTH_HEADER` env + `--mcp.extra-headers / --mcp.discovery-extra-headers` 自动转发本机凭据（doctor/run 一致，Secret 不进 argv）。
- 请求观测覆盖 401/403 拒绝（`authResult`）；Connector 诊断新增 CASE B-AUTH 与「开始一次 Connector 测试」窗口；bridgeVersion 升至 6。

### 第五轮优化（v1.4.0）：Tunnel Runtime/Doctor 修复 + MCP Discovery 兼容

- Doctor 与 Run 统一经 `TunnelProcessRunner.buildTunnelClientEnv()` 注入 `CONTROL_PLANE_API_KEY`（此前 doctor 子进程缺 Key 被误判为权限不足）；进程输出统一脱敏。
- 错误分类严格区分 `RUNTIME_KEY_MISSING_IN_PROCESS` / `RUNTIME_KEY_UNAUTHORIZED`（401）/ `TUNNEL_PERMISSION_DENIED`（403）/`RUNTIME_KEY_NOT_CONFIGURED`。
- Doctor 解析官方 `CHECK ... PASS/FAIL/SKIP` 行为三态诊断；exit != 0 时未验证项显示 unknown，不虚构绿色。
- 程序检测增加 `doctor --help`/`run --help` 校验，区分完整 CLI 与 runtime-only 包。
- MCP Server 支持无状态现代请求：不带 session 的 POST 按 JSON-RPC method 分流（initialize 走会话，tools/list、tools/call 走 stateless transport）；新增最近 50 条请求观测（`PromaMcpServerStatus.recentRequests`）与设置页展示。
- 新增 ChatGPT Connector 端到端诊断（CASE A/B/C 归类）与 Runtime Key 权限文案；preload bridgeVersion 升至 5。

### 第四轮修复（v1.3.1）：MCP 设置页生产白屏 + 渲染层边界

- 根因：MCP 设置页 JSX 引用 `process.platform`，生产渲染层（contextIsolation + nodeIntegration:false、无 polyfill）抛 ReferenceError 导致整页白屏；已改为静态文案（tunnel-client / tunnel-client.exe）。
- 防护：新增 `McpServerSettingsErrorBoundary`（BotHub 包裹）、渲染层配置/Tunnel 状态防御 normalize、preload 能力检测与 `bridgeVersion: 3` 版本协商、Tunnel 状态推送降级。
- 回归：`check:renderer-boundaries`（源码 Node 全局扫描，418 文件零命中）与 `smoke:renderer-dist`（产物未替换调用扫描，780 文件干净）两个脚本入库。

### 第三轮优化（v1.3.0）：Tunnel Client 产品化 + Codex 授权显式化

提交范围：`7af3041d`（第二轮收尾）之后的功能版本提交；应用版本 1.2.1 → 1.3.0。

行为边界：

- OpenAI Tunnel Client 升级为三种来源模式（managed / custom-path / system-path），旧 `clientCommand` 配置一次性迁移；任意 Shell 表达式不再执行。
- Tunnel 进程全部 `shell: false` 直接 spawn；检测必须 `--version` 退出码为 0；stdout/stderr 用 `StringDecoder` 解码，Windows 不再出现代码页乱码。
- Tunnel readiness 以 `/healthz` → `/readyz` 为准，删除「存活 8 秒 = 已连接」启发式；生命周期 phase 经 `mcp-tunnel:state-changed` 实时推送。
- 新增 `tunnel-client-adapter / manager / installer / types` 四个模块，CLI 参数统一由 Adapter 构造，Runtime API Key 仍只经 `CONTROL_PLANE_API_KEY` 环境变量注入。
- ChatGPT Setup 重构为八步向导（三平台分工 + 复制关系表 + 测试提示词 + 最近工具调用显示）。
- Codex OAuth：「登录」绝不自动打开浏览器；新增 `codex-oauth-open-browser` 专用 IPC（Renderer 只传 sessionId，Main 校验 https 后打开当前会话的官方授权地址）；打开可重复、失败不终止会话；Device Code 同规则；快照移除 `autoOpenBrowser` / `browserOpened`。

涉及区域：`mcp-server/tunnel-*`、`codex-oauth-session-controller`、`ipc.ts`、`preload`、`McpServerSettings.tsx`、`ChannelForm.tsx`、`packages/shared` 契约与测试。

### 定制提交：自建模型推理档位

提交：`0a19e2643afbcca9eb34b0c052c8ab09b68a8362`
父提交：`c63fb3e6166b4a6b2796688f920c719dcd4fb0a9`
提交时间：2026-08-26 20:57（UTC+8）
提交说明：`feat(reasoning): 支持自建 OpenAI 兼容模型配置推理档位 / support custom reasoning levels for self-hosted models`

变更规模：31 个文件，新增 934 行，删除 54 行。

行为边界：

- 在 shared 类型层增加频道模型的推理档位、默认值和 thinking 映射。
- 在 OpenAI Chat Completions / Responses 适配器中传递 `reasoning_effort`。
- 对 Agent 与 Chat 暴露自建模型的推理档位选择，并保持内置模型 profile 优先。
- 通过 IPC、preload 和 renderer 状态把频道级能力传到 Pi runtime。
- 同批次增加渠道配置跨窗口广播，保证多个窗口看到同一份渠道列表。
- 配套增加 shared、core、main 和 renderer 的 BDD 风格测试。

完整变更可以随时从 Git 恢复或查看：

~~~powershell
git show --stat 0a19e264
git show 0a19e264 -- apps/electron packages
~~~

定制提交涉及的主要区域：

| 区域 | 文件/职责 |
| --- | --- |
| Shared 契约 | `packages/shared/src/types/reasoning-profile.ts`、`channel.ts`、`chat.ts` 及其测试 |
| Provider 适配 | `packages/core/src/providers/openai-adapter.ts`、`openai-responses-adapter.ts`、`types.ts` 及测试 |
| Pi 能力注册 | `apps/electron/src/main/lib/adapters/pi-model-registry.ts`、`pi-agent-adapter.ts` 及测试 |
| Agent / Chat 主进程 | `agent-orchestrator.ts`、`chat-service.ts`、`ipc.ts` |
| IPC 边界 | `apps/electron/src/preload/index.ts` |
| UI 与会话状态 | `AgentView.tsx`、`ChatInput.tsx`、`ChatView.tsx`、`ChannelForm.tsx`、`chat-atoms.ts`、`useConversationSettings.ts`、`channel-model-reasoning.ts` |
| 版本与锁文件 | `apps/electron/package.json`、`packages/core/package.json`、`packages/shared/package.json`、`bun.lock` |

### 本次维护提交：v0.18.3 构建记录

提交：`57e18e308e5d214fffbb935c68ac3911dc11412c`
提交说明：`chore: prepare Proma v0.18.3 release`

该提交包含构建指南、README 版本修正、Windows 测试隔离修正和版本元数据更新。它不是上游产品定制功能；同步上游时应保留文档和测试修正，但应用版本号以待发布的上游/本地版本策略为准，不要把 `0.18.3` 强行覆盖上游的新版本。

### 定制提交：llama.cpp 工具语法边界修复

提交：`92c24992c3b00b2c8a1eccf149108297a34b9bad`（应用 `0.19.9` / `@proma/core 0.2.19` 起）

行为边界：

- `BrowserAct.waitFor.value` 等嵌套字符串的 `maxLength` 从 2000 降到 1024，规避 llama.cpp `char{1,2000}` 重复规则上限导致的 400。
- 新增 `packages/core/src/utils/grammar-bounds.ts`：递归扫描工具 JSON Schema，找出「嵌套 + maxLength ≥ 2000」的危险字符串；`openai-adapter` 序列化工具时命中即 `console.warn`，不 silently 改写。
- `AskUserQuestion` / collaboration 的 `answers` 从无约束 `Record` 改为有界对象数组（`ask-user-tool-schema.ts`），避免网关剥离 `additionalProperties` 后展开成递归 GBNF。

完整排查过程与「以后新增/修改工具的检查清单」见 [llama.cpp 工具语法限制排查记录](./llama-cpp-tool-grammar-limits.md)；502 连带失败的根因分析见 [qwen-lite 502 上游诊断](./qwen-lite-502-upstream-diagnosis.md)。同步上游时若官方调整了内置工具 schema，需按该检查清单复核嵌套字符串长度。

### 定制提交：Windows 一键构建脚本

提交：`358c42e2da685e22a0ad9d02f7338bd29c70a856`（应用 `0.19.25` 起）

- `scripts/build-win.ps1`：`bun install` → typecheck/test（`-SkipCheck` 可跳过）→ 全量构建 → electron-builder `--win`，产物为 `apps/electron/out/Proma Setup <版本>.exe`。
- `-Push` 参数在构建成功后自动推送 `origin main`；脚本以 UTF-8 BOM 保存，兼容 Windows PowerShell 5.1 中文输出。

用法见下文「构建速查」。

### 定制提交：未标注代码块语言误判修复

提交：待提交（2026-09-05，`@proma/core 0.2.20` 起）

行为边界：

- 现象：模型在未标注语言的 fenced code block 中输出文件清单（每行一个带斜杠的路径）时，`detectLanguage` 的 highlight.js 自动检测会将其误判为 swift / css / bash 等语言（如 5 行 `apps/electron/...` 路径列表以 relevance 11 命中 swift），代码块顶栏显示错误语言标签、内容按错误语法高亮。
- 修复：`detectLanguage` 在自动检测前先识别「整块都是路径」（每个非空行均为无空白的单个路径 token），命中直接回退 `text`；带空格的命令、注释、真实代码不受影响，仍走自动检测。
- 回归测试：`packages/core/src/highlight/language-detector.test.ts`，覆盖 swift / css 两个误判回归场景与真实代码仍可识别的正向用例。

### 定制提交：QuickAsk 临时提问浮窗

提交：待提交（2026-09-05，应用 `0.19.27` / `@proma/shared 0.1.69` 起）

行为边界：

- Chat 与 Agent 头部新增「临时提问」按钮；assistant 回复的操作栏新增同名入口，点击会把该回复预填到浮窗输入框（超过 6000 字符截断）。
- 浮窗支持独立选择渠道、模型与推理档位（模型选择器排除 `openai-codex` / `xai`，与 Chat 主流程的 OAuth 限制一致），可拖动、可缩放，悬浮于任意视图之上。
- 对话完全独立：主进程仅以 `quick-ask-store.ts` 保存内存消息，不写 JSONL 与 conversations.json 索引，不进入 Agent / Chat 任何会话；关闭浮窗即销毁，「清空」仅清消息。
- 流式事件走独立的 `QUICK_ASK_IPC_CHANNELS` 通道族，不触碰 Chat 全局流状态；不支持工具与附件，规避工作区副作用。
- 同步上游时注意四层契约需整体保留：`packages/shared/src/types/quick-ask.ts` → `ipc.ts` handler → `preload/index.ts` bridge → `QuickAskPanel.tsx`。

## 构建速查（Windows）

日常开发与打包的完整细节见 [构建指南](./build.md)。最常用的入口：

~~~powershell
# 一键构建安装包（含 typecheck + test）
powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1

# 跳过检查快速打包
powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1 -SkipCheck

# 构建成功后推送 origin main
powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1 -Push
~~~

等价的标准流程（脚本内部即按此顺序执行）：

~~~powershell
bun install --frozen-lockfile
bun run typecheck
bun test
bun run --filter='@proma/electron' dist:win
~~~

要点：

- Windows 打包默认验证并使用 node-pty 官方预编译 N-API 产物（`prepare:node-pty` 会在 Electron 中实际启动一次 PTY）；只有预编译缺失时才回退源码重编译，那时才需要 Visual Studio 2022 C++ 工具链与 Spectre 库。
- 源码重编译报 `MSB8040`（缺 Spectre 库）时，安装 VS 组件 Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre，不要通过删 gyp 安全选项绕过。
- `bun` 找不到时先重启终端确认 PATH；`build-cli` 依赖 PATH 中的 Bun。
- 根 `package.json` 的 `trustedDependencies` 含 `electron`：Bun 1.4 起默认不运行未信任依赖的 postinstall，缺这条会导致全新安装后 `node_modules/electron/dist` 二进制缺失，`prepare:node-pty` 与打包验证全部失败。
- 根目录 `bunfig.toml` 把 linker 固定为 hoisted：Bun 1.4 对 workspace 默认 isolated，会让依赖解析路径漂移并破坏打包；一键脚本也显式传了 `--linker hoisted` 双保险。
- 产物位于 `apps/electron/out/`，已被 `.gitignore` 忽略，不应提交。

### 定制提交：飞书卡片显示渠道名

提交：待提交（2026-09-05，应用 `0.19.28` 起）

- 现象：飞书流式卡片底部只显示模型 ID；同一模型存在于多个渠道时无法分辨实际使用的渠道。
- 修复：`FeishuBridge.resolveModelDisplay()` 按 binding > Bot 配置 > 应用设置解析「渠道名 / 模型名」，经 `RenderOptions.modelDisplay` 传入全部 5 个卡片渲染点（镜像卡、运行卡、增量卡、错误/中断终态卡）；解析失败回退原始 modelId。`/now` 命令本就显示渠道名，保持不变。

## 上游更新后的推荐流程

### 自动流程（推荐）

先在本地只检查上游：

~~~powershell
git switch main
git config rerere.enabled true
bun run sync:upstream
~~~

确认待合并提交后执行：

~~~powershell
bun run sync:upstream --apply --verify
~~~

脚本会自动创建类似下面的分支，并在成功后停留在同步分支：

~~~text
backup/main-before-upstream-20260830-123456
sync/upstream-20260830-123456
~~~

如果没有冲突且验证通过，按脚本输出快进并推送：

~~~powershell
git switch main
git merge --ff-only sync/upstream-<时间戳>
git push origin main
~~~

如果出现冲突，脚本会停在同步分支；解决后执行：

~~~powershell
git add <已解决的文件>
git commit -m "chore: resolve upstream sync"
bun run verify:upstream
~~~

验证失败时保留同步分支排查，不要把未验证的合并结果快进到 `main`。脚本从不自动修改 `main` 或推送远端。

### 1. 先保存当前状态并获取上游

~~~powershell
git status --short --branch
git switch main
git pull --ff-only origin main
git fetch upstream --prune
git rev-list --left-right --count upstream/main...main
git log --oneline --decorate main..upstream/main
~~~

如果工作区不是干净状态，先提交当前工作，或明确保存为临时 stash。不要带着未记录的改动开始同步。

### 2. 建立同步分支和备份点

~~~powershell
$stamp = Get-Date -Format yyyyMMdd-HHmmss
git branch "backup/main-before-upstream-$stamp"
git switch -c "sync/upstream-$stamp" main
git merge --no-commit upstream/main
~~~

同步分支用于处理冲突和验证。`main` 在验证完成前保持不动；如果合并过程需要放弃：

~~~powershell
git merge --abort
~~~

### 3. 先处理上游合并，再按需重放定制提交

确认上游合并内容后提交合并结果，或者在合并提交状态下继续执行：

~~~powershell
git status
git add <已解决的文件>
git commit -m "chore: merge upstream main"
~~~

当前 `main` 已包含适配后的定制实现，日常同步不要再执行 `git cherry-pick 0a19e264`。只有在从 `upstream/main` 或其他干净基线重新建立一个没有定制的 Fork 时，才使用该历史提交作为重放入口：

~~~powershell
git cherry-pick 0a19e264
~~~

也可以直接从旧定制分支创建一个独立重放分支（仅用于灾备/从零恢复）：

~~~powershell
git switch -c "sync/custom-reasoning-$stamp" origin/feat/custom-model-reasoning
git rebase upstream/main
~~~

日常同步优先使用自动流程；手动流程只用于脚本无法处理的冲突或从零恢复。当前主分支已经把上游和定制提交串在同一条历史中，Git 的三方合并会自动携带非冲突定制。

### 4. 冲突处理原则

定制提交与上游有 17 个文件重叠，预计最需要人工复核的是：

~~~text
apps/electron/package.json
apps/electron/src/main/ipc.ts
apps/electron/src/main/lib/adapters/pi-agent-adapter.ts
apps/electron/src/main/lib/adapters/pi-model-registry.ts
apps/electron/src/main/lib/agent-orchestrator.ts
apps/electron/src/main/lib/chat-service.ts
apps/electron/src/preload/index.ts
apps/electron/src/renderer/atoms/chat-atoms.ts
apps/electron/src/renderer/components/agent/AgentView.tsx
apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx
apps/electron/src/renderer/components/chat/ChatInput.tsx
apps/electron/src/renderer/components/chat/ChatView.tsx
apps/electron/src/renderer/components/settings/ChannelForm.tsx
apps/electron/src/renderer/main.tsx
bun.lock
packages/shared/package.json
packages/shared/src/types/reasoning-profile.ts
~~~

处理顺序：

1. 保留上游最新的 Pi runtime、Electron 和依赖版本；不要把定制提交中的旧版本号直接带回去。
2. 以当前上游的 shared 类型为基线，把频道级 reasoning 字段重新接入，并检查导出入口。
3. 以当前上游的 provider / Pi registry 为基线，重新应用“内置 profile 优先、频道声明 fallback”的行为。
4. 再恢复 IPC、preload、Agent/Chat UI 和会话状态，避免只修 UI 而丢掉线上参数透传。
5. 重新检查新增测试，必要时把测试断言改为上游当前接口，而不是删除测试。

查看冲突和定制原始补丁：

~~~powershell
git status
git diff --name-only --diff-filter=U
git show 0a19e264 -- apps/electron/src/main/lib/adapters/pi-model-registry.ts packages/shared/src/types/reasoning-profile.ts
~~~

如果确认无法继续重放：

~~~powershell
git cherry-pick --abort
~~~

不要用 `git reset --hard` 覆盖工作区；先保留同步分支和备份分支，方便重新比较。

### 5. 验证并合并回 main

~~~powershell
bun run verify:upstream
git diff --check
git diff --stat upstream/main...HEAD
git log --oneline --decorate upstream/main..HEAD
~~~

Windows 桌面构建：

~~~powershell
bun run --filter='@proma/electron' dist:win
~~~

如果本机缺少 Visual Studio Spectre 库，`prepare:node-pty` 会优先验证官方预编译 N-API 产物；需要源码重编译时再按 [构建指南](./build.md) 补齐 native 工具链。确认安装包、CLI 和 `node-pty` 均通过后，再合并同步分支：

~~~powershell
git switch main
git merge --ff-only sync/upstream-<时间戳>
git push origin main
~~~

如果应用行为或安装包版本发生变化，更新 `apps/electron/package.json`、对应锁文件和发布记录；仅文档/维护记录变更也要递增对应项目版本号。

## 快速判断是否需要同步

每次开始工作前可以执行：

~~~powershell
git fetch upstream --prune
git rev-list --left-right --count upstream/main...main
git log --oneline --decorate main..upstream/main
~~~

输出的两个数字分别是“上游独有提交数”和“本 Fork 独有提交数”。只要第一个数字大于 0，就说明上游有新内容；先在同步分支中评估，不要直接把 `upstream/main` 拉进生产分支。

若要确认定制提交仍可独立重放：

~~~powershell
git show-ref --verify refs/remotes/origin/feat/custom-model-reasoning
git merge-base --is-ancestor 0a19e264 origin/feat/custom-model-reasoning
git show --stat 0a19e264
~~~

## 维护约定

- 上游只通过 `upstream` 获取，不直接把 Fork 的 `origin` 当成上游。
- 每个本地功能保持为独立、可 cherry-pick 的提交；不要把上游合并提交和定制实现混成一个无法识别的大提交。
- 日常更新使用 `sync:upstream` 创建一次性同步分支；不要在 `main` 上直接试错，也不要每次重复 cherry-pick 已经进入 `main` 的提交。
- 定制功能涉及多个 IPC 层时，继续同时维护 shared、main、preload、renderer 和测试。
- 每次成功同步后，更新本文的快照提交、应用版本、共同基点和冲突清单。
- 发布前保留 `git diff upstream/main...HEAD` 和 `git range-diff` 的审查记录，确认没有误覆盖上游改动。

## 独立版本号策略

自 `v1.0.0` 起，本 Fork 使用独立版本号，不再跟随上游 `0.19.x` 序列：

- **patch**：缺陷修复与构建改进；**minor**：功能新增或大型上游合并；**major**：预留重大变更。
- 每个 Release 说明标注基于的上游基准（tag 或 commit），Release 产物由 `v*` tag 触发的 CI 自动构建。
- 应用版本（`apps/electron/package.json`）与根工程版本（`package.json`）随 Release 同步到同一版本号；`packages/*` 内部库版本保持各自序列。
- README 顶部保留 Fork 横幅，说明差异清单与本策略，控制篇幅以降低与上游 README 的合并冲突。

## 相关文件

- [构建指南](./build.md)
- [一键 Windows 构建脚本](../scripts/build-win.ps1)
- [上游同步脚本](../scripts/sync-upstream.ts)（含 [测试](../scripts/sync-upstream.test.ts)）
- [llama.cpp 工具语法限制排查记录](./llama-cpp-tool-grammar-limits.md)
- [qwen-lite 502 上游诊断](./qwen-lite-502-upstream-diagnosis.md)
- [根目录 AGENTS.md](../AGENTS.md)
- [GitHub Actions 发布工作流](../.github/workflows/release.yml)
