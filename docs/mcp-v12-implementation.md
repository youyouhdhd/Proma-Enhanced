# V12 开发与验收记录

基线：v1.9.1 / 0b00847c。目标：v1.10.0 预发行版。

## 执行清单

- [x] 基线测试、类型检查、生产构建与 Windows MCP 冒烟。
- [x] 稳定 Connector / ngrok 多项目热增删测试、workspace_open、目录身份和批量授权。
- [x] 脱敏日志缓冲、进程输出与结构化错误。
- [x] 独立 ngrok Provider：系统配置、可选受管凭据、自定义配置、固定及临时域名。
- [x] 远程读写执行策略、逐项目权限、调用时复核、限流与紧急撤销。
- [x] Agent 多目标验证、fallback / round-robin / manual、固定任务根及尝试审计。
- [x] 分拆设置组件、Provider 能力驱动字段、批量操作、帮助与安全诊断。图形交互验收另列为待完成。
- [ ] 回归、生产构建、打包、提交及 Actions 验证。
- [ ] 真实 ngrok 固定域名 + 单 ChatGPT Plugin + 三项目及第四项目热添加人工验收。

## 实现边界

复用 LocalToolRegistry 与路径守卫执行 Direct 写入/Shell。Approval 采用非阻塞任务接口或明确标记未提供，不允许选择后静默直接执行。Parallel 和附件导入按需求文档列为非阻塞项。默认迁移保持写入和 Shell 关闭。

Provider 连接身份只依赖 origin 与 Secret。共享根、权限和 Agent 配置不能重启 Provider 或改变 Secret。工具定义指纹不包含根列表和目标模型列表。

自动测试使用隔离目录、模拟 Provider 和模型运行器；不能把脚本通过记成真实账号/ChatGPT 验收通过。

## 参考

- CodexPro 固定参考提交：587f7fd3a4644a847bba13aeb49336056052e1f6。
- https://raw.githubusercontent.com/rebel0789/codexpro/587f7fd3a4644a847bba13aeb49336056052e1f6/DOMAIN_SETUP.md
- https://ngrok.com/docs/gateway/agent/config

ngrok config check 验证配置文件并报告位置，不单独证明云端认证成功；认证成功以启动和公网探测为准，UI 必须区分这两项。

## 迁移与使用

应用版本 1.10.0，共享包 0.5.0，bridge 12；Sharing v1 升级为 v2，Remote v2 升级为 v3。旧分析 channel/model 迁为一个稳定目标；旧配置不会自动开启写入或执行。已有受管 ngrok Secret 保留受管认证模式，没有时默认系统配置，域名原样保留。

首次配置 ngrok：安装官方 CLI，完成 `ngrok config add-authtoken`，在 Proma 选择系统配置并检测，填写账号分配的 HTTPS 域名后启动。配置检查不读取展示明文 Token。本轮本机真实 `ngrok config check` 已通过；固定域名公网和 ChatGPT 尚未验收。

新增项目只改变 workspace_list 数据。workspace_open 按 ID/名称解析，不设置隐藏当前项目；多个项目省略 ID 返回 WORKSPACE_REQUIRED 及 choices。同目录别名使用 Windows 文件身份或规范路径识别，既有共享 ID 优先复用。

Write/Shell 必须同时满足全局 Direct、工具组开启、项目对应权限及端点授权。调用时再次检查，因此关闭后旧缓存调用也会拒绝。Shell 单并发、默认每分钟 10 次；写入默认并发 2、每分钟 60 次，可在高级设置调整。Shell 工作目录限制不是操作系统沙箱。紧急撤销先中止活动任务、关闭远程入口和 Provider，再轮换 Secret；已经完成的写入不会回滚。

Approval 按需求第 7 节允许的非阻塞方案保留契约，但本版没有审批执行界面，选项禁用；旧/手工配置中的 approval 会拒绝执行，绝不会自动按 Direct 执行。Parallel 与附件 import_file 未实现，均为文档列出的非阻塞项。

分析任务支持 Fallback、轮询和 Manual；可选择多个渠道模型，检查每个目标授权。默认并发 1、等待 3，可调整为并发最多 4、等待最多 20；单任务仍有超时与去重。任务绑定原项目，目标设置热改只影响后续任务，不重启 Provider；撤销读取或关闭分析则取消活动任务。取消不会启动后续 Fallback。尝试审计只记录目标、起止时间和结果类型。

## 验证与发布操作

```powershell
bun run typecheck
bun test
bun run --filter='@proma/electron' test:mcp-sharing
bun run --filter='@proma/electron' test:mcp-transport
bun run electron:build
bun run --filter='@proma/electron' smoke:renderer-dist
bun run --filter='@proma/electron' smoke:mcp-bundle (Resolve-Path 'node_modules/electron/dist/electron.exe').Path
```

构建和打包必须串行，electron-builder 运行期间不要重建 renderer，否则带哈希文件名的资源被替换会造成 ENOENT。最终包使用独立版本目录，检查 ASAR 中版本及所有构建文件摘要。

本轮基线 662 项、当前回归 671 项通过；均未调用付费模型，Direct Shell 测试只在隔离目录执行 echo。补充覆盖迁移、ngrok 系统/自定义配置、稳定域名模拟重启、日志脱敏、目录别名、Direct 写入/Shell、权限热撤销、Fallback/轮询/Manual 及取消边界。

本地生产构建通过，renderer 780 个产物文件扫描通过，Electron 43.2.0 / Node 24.18.0 下 Local + Public MCP CJS 冒烟通过。最终额外复核将任务根路径固定在异步授权检查之前，避免授权期间项目路径变更影响任务绑定。

浏览器控制连接超时，未把模拟 UI 交互记为通过。真实 ngrok 固定域名 + 单 ChatGPT Plugin + 至少三个项目与第四项目热添加仍需安装后人工验收；在这些 Gate 完成前只能发布 prerelease，不得标 Stable。

## 真实 ngrok 启动排查

可复用脚本：`bun run apps/electron/scripts/test-mcp-ngrok-live.ts`。脚本只暴露新建隔离测试目录，完成后停止自己创建的进程并清理目录，不调用模型。不要在同账号 Assigned Domain 已由其他连接使用时运行。

2026-09-10 实测首次返回 ERR_NGROK_9009：Proma 通用 HTTP 代理环境被 ngrok 继承，触发账号计划限制。修复为仅对 ngrok 子进程移除 HTTP/HTTPS/ALL_PROXY 环境变量，保留用户 ngrok.yml 显式 proxy_url；错误单独分类 NGROK_PROXY_PLAN_REQUIRED。官方依据：https://ngrok.com/docs/errors/err_ngrok_9009 。

修复后重试返回 ERR_NGROK_334（NGROK_ENDPOINT_ALREADY_ONLINE），确认存在早于本轮测试启动的用户 ngrok 进程；未停止或改动该连接，也未启用 pooling 将测试混入用户端点。故本次真实公网 Gate 未通过，不能标记为 PASS。另补充停止自有 ngrok 子进程时等待退出，再允许重连，避免自身旧进程释放端点的竞态。
