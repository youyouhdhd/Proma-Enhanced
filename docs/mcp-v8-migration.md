# V8 官方 MCP 迁移与验收记录

## 迁移调研（2026-09-08）

- 基线：桌面应用 1.6.0，`@modelcontextprotocol/sdk ^1.29.0`。V7 手写 Discovery 使用 `protocolVersions` 和顶层 `serverInfo`，与当前官方协议不一致；响应捕获函数未接入路由。
- 目标：精确锁定官方稳定包 `@modelcontextprotocol/server`、`@modelcontextprotocol/node`、测试包 `@modelcontextprotocol/client` 为 2.0.0。Bun registry 查询确认 latest=2.0.0，发布于 2026-07-27；锁文件记录依赖完整性。
- 现代 API：`createMcpHandler(factory)` 自动安装 `server/discover`、验证每请求协议 metadata、生成官方 `supportedVersions` 与 `_meta`。不由 PROMA 拼装现代协议响应。
- 工具：官方 Server 的 `setRequestHandler('tools/list', …)` / `setRequestHandler('tools/call', …)` 接现有 LocalToolRegistry；工具只实现一次。
- Node HTTP：`toNodeHandler(handler)` 接入 `http.createServer()`；入口保留认证、endpoint 范围和安全观测。
- 旧客户端：官方 isLegacyRequest 判定时代后，legacy 流量进入独立 v1 adapter（initialize、stateless、GET/SSE、DELETE）。现代流量交给 v2；Session 必须与 Profile 匹配。
- 运行环境：三个官方包要求 Node >=20；当前 Electron 43 满足。SDK 同时导出 ESM/CJS，可由现有 esbuild CJS 主进程构建打包，无须新增 external 或裸 ESM 动态加载。
- 官方 Client：`versionNegotiation: { mode: 'auto' }` 与 pin 模式；断言 `getProtocolEra() === 'modern'`、tools/list、实际工具调用及请求中没有 initialize。
- 渐进迁移：仅迁移对外 MCP Server，不改 Proma 的 MCP Client、Pi runtime、Tunnel 进程、OAuth。
- 回滚：仅开发环境允许 `PROMA_ENABLE_LEGACY_MCP=1`。V7 shim 从生产调用链移除，暂保留原文件作为历史对照；只有真实 ChatGPT 通过后才删除文件。

## 官方依据

- [协议时代与 Client 协商](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)
- [官方 HTTP handler 与 Node 适配](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)
- [Discovery schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/discover.mdx)

## 执行与验收清单

- [x] 安全 trace：响应结束后记录，JSON/SSE RPC 结果、406 metadata、有限内存、不导出参数或响应内容。
- [x] 官方 handler 和 legacy adapter；共享工具权限与 profile 隔离。
- [x] 官方 Client 与 wire 测试；JSON-only Accept 按官方 handler 行为验证。
- [x] era / fallback / transport / tool discovery 诊断、两分钟调试与安全导出、bridge 升级。
- [x] 全量测试、类型检查、生产构建、renderer 静态扫描、Windows 打包及 Electron Node 冒烟（不含 GUI 验收）。
- [ ] 真实 ChatGPT Connector 创建、workspace_list、git_status、read_file。必须记录真实结果，不以单元测试替代。
- [x] 检查 diff、递增交付版本、准备详细 Release 说明。
- [ ] 推送后检查各平台 Actions 与资产；最终结果在对应 GitHub Release 中记录。

文档所列历史两次 406 未附 Accept/Content-Type 实际值，不能伪称已重现该 fixture。新调试窗口用于补采；本地合成 header 矩阵单独标记。

## 实现与验证记录

- 应用版本 1.7.1（1.7.0 的 CI 前置条件补丁），共享契约包 0.2.1，preload bridge 8。
- 本地 633 项测试通过；官方 Client 的 auto/pin 模式均返回 modern，无 initialize 回退；workspace_list、git_status、read_file 实际执行成功。
- 两级测试命令：`bun run --filter='@proma/electron' test:mcp-wire`、`bun run --filter='@proma/electron' test:mcp-official-client`。
- 已运行 endpoint：`bun run --filter='@proma/electron' test:mcp-live <endpoint>`。raw HTTP 脚本仍是 `test:mcp-modern`；认证只通过 PROMA_MCP_AUTH_HEADER 环境变量传入，禁止把密钥写在参数中。
- 构建顺序：`bun install --frozen-lockfile` → `bun run --filter='@proma/electron' prepare:electron` → `bun run typecheck` → `bun test` → `bun run electron:build` → renderer 边界/产物扫描 → `bun run dist:win`。
- 若只是同步运行时依赖之后又改了源码，可重新 build 后用 `bunx electron-builder --win --x64 --publish never` 更新安装包；运行时依赖变化则必须重新同步。
- 本地 Windows NSIS 打包完成。同步运行时依赖可能需要数分钟；不能把无新日志误判为完成。
- `bun run --filter='@proma/electron' smoke:mcp-bundle` 将同一 MCP 实现打为 CJS，并用 out/win-unpacked/Proma.exe 的 Electron Node 模式运行隔离临时仓库测试；实际 Node=24.18.0，Electron=43.2.0，通过。它不验证 GUI。
- 所有 13 个已公开工具使用官方 isSpecType.Tool/ListToolsResult 验证；基线无 apply_patch 工具，不新增未经需求定义的写入能力。
- 递归列目录/搜索增加 symlink/junction 边界回归；隐藏工具不能直接执行，缺失密钥不能放行；旧 Session 的 Profile 绑定在每次请求检查。

## Accept 结论

[当前 Streamable HTTP 规范](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx)仍要求客户端声明 JSON 和 SSE。SDK 现代路径可返回终态 JSON；PROMA 的 JSON-only 兼容策略保留这个行为，拒绝明确不能接受 JSON 的 Accept，且不篡改入站 headers/metadata。历史两次 406 的真实原因须由新调试采集确认。

## 发布与真实验收边界

本次以预发布交付；源码提交、构建和自动验证完成不等于 V8 Definition of Done 全部通过。真实 ChatGPT 浏览器控制发生导航超时，未取得 App 创建成功证据；也未覆盖安装并操作正式设置页。用户应完成本文档和 Release 所列测试后，再将同一版本转为正式发布、删除历史 shim。现有 Tunnel runner、密钥存储、OAuth 主动打开浏览器流程没有重写。

Release 工作流新增 verify-mcp 门禁（类型检查、全量测试、renderer 源码扫描），各平台构建成功后检查资产；发布说明从 release-notes/v1.7.1.md 提交与维护，不再仅用一行 Git 提交信息。

## Actions 故障与稳定修复（1.7.1）

- [1.7.0 首轮 Actions](https://github.com/youyouhdhd/Proma-Enhanced/actions/runs/34201342714)：632 pass / 1 fail；失败为既有 planning-manager.test.ts，所有 V8 MCP 测试通过。构建被验证门禁阻止，未发布 1.7.0 安装包。
- 日志表现：spawnSync 的 stdout/stderr 为 null、退出码缺失。测试绕过 Electron CLI，直接启动 node_modules/electron/dist/electron.exe；干净 runner 上只有 JS 包，尚无二进制。本地已下载过，所以未暴露。
- 官方从 Electron 42 起移除下载二进制的 postinstall，改为 CLI 首次运行动态下载；本仓库 Electron 43.2.0 的 package.json 同样没有 postinstall。依据：[官方变更说明](https://www.electronjs.org/docs/latest/breaking-changes/)、[官方安装指南](https://github.com/electron/electron/blob/main/docs/tutorial/installation.md)。
- 修复：提供 prepare:electron（bunx --no-install install-electron），在 CI 全量测试前显式执行锁定依赖的官方安装器。已有二进制时直接复用，下载失败就停止；不依赖本地缓存，不关闭门禁或跳过 Planning 测试。
- 测试增加二进制存在检查、spawn error 断言及 windowsHide，今后缺环境会输出可执行的修复命令。
- 保留失败标签 v1.7.0 作为审计记录，不移动已推送标签；新补丁提交与发布使用 v1.7.1。gh 默认可能选择官方上游，所有发布操作必须显式加 `-R youyouhdhd/Proma-Enhanced`。
- 本地 1.7.1 构建与 typecheck 并行时，esbuild 曾出现一次原生进程 `0xc0000005` fault；类型检查结束后串行重跑同一构建成功。该次崩溃未定位到源码错误，不能宣称永久消除；保留原始日志并优先串行执行构建验证，重复出现时再调查 esbuild/系统环境，不靠无限重试掩盖失败。
