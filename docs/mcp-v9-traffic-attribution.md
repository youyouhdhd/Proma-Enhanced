# V9 Connector 流量归因与验收记录

交付版本：应用 1.7.2、共享契约 0.2.2、preload bridge 9。基线为 v1.7.1 / ea8a3f9c。V8 官方 MCP SDK 2.0.0、Modern handler、Legacy adapter、Tunnel runner 与凭据存储继续复用。

## 问题与依据

V9 文档提供的安全形状为：空 POST /mcp（Accept application/json，无 Content-Type）、无会话 GET /mcp，以及两个 oauth-protected-resource well-known URL。旧实现让空 POST 进入 Legacy transport，导致 406，再把这些 HTTP 请求当作 Connector 协议失败。

已检查官方代码：

- [OAuth metadata probe](https://github.com/openai/tunnel-client/blob/master/pkg/oauth/resource_meta.go)：使用空 Body，依次尝试 POST / GET，设置 application/json Accept 与官方 UA，随后探测 well-known。
- [官方客户端 UA](https://github.com/openai/tunnel-client/blob/master/pkg/version/version.go)：客户端名称为 oai-tunnel-client。
- [转发标记回归](https://github.com/openai/tunnel-client/blob/master/pkg/dispatcher/internal/processor_test.go)：测试转发 X-Openai-Subject / X-Openai-Session 等入站头。
- [现代 HTTP 规范](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx)：现代请求为单个 JSON-RPC request/notification。旧 SDK 可处理 batch，本轮保留其行为，不自行扩展现代协议。

fixtures/tunnel-oauth-probe.ts 只固化用户文档已提供的请求形状。测试中附加的官方 UA 和转发标记明确属于合成 fixture，不能称为真实 ChatGPT 抓包。

## 路由与权限

顺序：Host/Origin 验证 → health/well-known → endpoint → 有界 Body 解析与意图分类 → Local auth → Probe/Session/RPC 分支。

- 空 POST：认证满足后返回 HTTP 400 与 MCP request body required，不分配协议时代，不调用 Legacy transport。
- 无会话 GET：405 / Allow POST；well-known：404，单独记录分类。
- 非法 JSON：400 / -32700；合法非 RPC JSON：400 / -32600；超过 1 MiB：413。
- 有会话 GET/DELETE：进入原 Legacy adapter，继续校验 Session 存在及 Profile 边界。
- 合法 RPC/notification：才调用官方 isLegacyRequest。旧 batch 委托官方 transport，一次 HTTP 一个 trace，标为 (batch)，不用于现代 Discovery Ready 证据。
- 为识别认证失败的 RPC，在 Local auth 前有限解析 Body；任何工具执行仍必须通过认证及原有工作区权限。Bearer 缺失的 probe 可以得到真实 401，本轮没有伪造 OAuth challenge，也没有绕过认证。

## 来源与结论边界

requestKind 与 requestSource 是两个独立维度。转发标记存在时优先归 connector-forwarded；没有标记但带官方 tunnel UA 的非 RPC 为 tunnel-client-internal，其 RPC 为 unknown；其他 RPC 归 local-mcp-client；无法判断的 HTTP 为 unknown。

sourceSignals 仅保存 hasOpenAiSubject / hasOpenAiSession / tunnelClientUserAgent 三个布尔值。原始 subject、session、Authorization、Cookie、Runtime Key、Bearer、工具参数和文件内容不进入 trace 或导出。

这些分类是诊断证据，不能保证真实身份“百分百可鉴别”：本机调用方可伪造标记，代理也可能移除标记和 UA。local-mcp-client 表示未见 Tunnel 证据，不能作为来源认证。无法归因时必须结合 Tunnel Logs，不能凭探测推断已经收到 ChatGPT RPC。

- 协议分析与 Connector 直方图仅统计 mcp-rpc 且来源为 connector-forwarded / unknown 的候选请求；本地 Client 与 probes 独立计数。
- UI 的 Connector RPC 数只计带转发标记的请求；unknown RPC 另列。内部探测总数、OAuth Probe、Well-known、本地 RPC 单独显示。
- 无候选 RPC → A-UPSTREAM，建议核对 command/dispatch；这只是“当前窗口缺少交付证据”，不能自动断定 Control Plane 已故障。
- B-AUTH / B-DISCOVER / B-ERA-FALLBACK / B-TRANSPORT / B-PROTOCOL 只分析候选 RPC。历史 probe 406、probe 400/405、well-known 404 不再阻断。
- Connector Ready 要求 /readyz 成功、modern、有效 tools/list、无候选 RPC transport 错误，并有同一 endpoint 上按序出现的带标记 Discovery 与 tools/list。
- OK 进一步要求带标记的成功工具调用；App 是否已保存仍以 ChatGPT 界面为准。

## Protocol Debug 与日志入口

两分钟窗口仅采集安全字段，结束后自动分析窗口内已经完成的记录。按窗口分析不运行 Doctor；界面在 Doctor/分析运行时禁止新开窗口，在窗口期间暂停 Doctor 与完整诊断，主进程 Doctor 也拒绝在活动窗口启动。分析时只读 /readyz 等运行态信息，health 不进入 Connector 统计。

打开 Tunnel Client Logs 由用户主动点击触发。专用 IPC 从当前运行态 healthUrl 派生 /ui#logs，仅允许本机 HTTP 地址，拒绝 URL 凭据并丢弃 query/旧 fragment。renderer 不提供任意外部 URL。

## 固定真实 E2E 流程

1. 启动 Local MCP 与既有 Tunnel，等待 /readyz 200；不要重建 Runtime Key 或 Tunnel。
2. 不运行 Doctor/完整诊断，开启两分钟 Protocol Debug，记录起点。
3. ChatGPT 创建 Custom MCP App，Connection 选 Tunnel，选择同一个 Tunnel，Authentication 选 none，Create 只点击一次。
4. 窗口结束后查看 Connector RPC、来源及协议阶段。
5. 成功时确认 server/discover → tools/list、App 创建成功，再请求 workspace_list；保存安全诊断。
6. 若只有 probes，打开 Tunnel Logs，再测试一次，记录是否有 command 和 localhost dispatch。仅在真实日志证明“没有 command”时，才把阻断定位到 ChatGPT/Tunnel delivery；有 RPC 则依据其 HTTP/RPC 结果继续排查。

## 构建与执行清单

使用 Bun，保持 V8 的 prepare:electron 前置条件。按顺序执行 typecheck、测试、build，避免并行 esbuild 与类型检查。本地打包使用独立版本输出目录，避免复用 NSIS 中间产物：

```powershell
bun install --frozen-lockfile
bun run --filter='@proma/electron' prepare:electron
bun run typecheck
bun test
bun run --filter='@proma/electron' test:mcp-wire
bun run --filter='@proma/electron' test:mcp-official-client
# 在 apps/electron 中：完整 build + runtime deps + pty + NSIS
bun run dist:win --publish never '--config.directories.output=out/v1.7.2'
bun run check:renderer-boundaries
bun run smoke:renderer-dist
bun run smoke:mcp-bundle 'F:\github project\Proma\apps\electron\out\v1.7.2\win-unpacked\Proma.exe'
```

- [x] 分类、probe 路由、来源/身份值隔离、HTTP/RPC 边界测试。
- [x] 10 条文档形状回归；probe 406 历史记录不误诊；实际 RPC 401/406 保留正确错误。
- [x] 官方 Modern Client、工具发现/执行、Legacy session 与 batch 回归。
- [x] 全量 641 项测试通过，类型检查通过。
- [x] 生产构建、renderer 两级扫描、Windows 打包与 Electron CJS 冒烟（Electron 43.2.0 / Node 24.18.0）。包内 997 个构建文件与最终 dist 校验一致。
- [ ] 提交、推送、Actions 与资产验证；最终结果记录在 GitHub Release。
- [ ] 真实 ChatGPT App/工具调用，或有实际 Tunnel Logs 支持的上游阻断结论。

本轮浏览器自动化访问 ChatGPT 超时，尚未取得真实 E2E 证据。自动化 fixture 不能替代真实验收，不能宣称已证明上游阻断；在真实验收补齐前按预发布交付。
