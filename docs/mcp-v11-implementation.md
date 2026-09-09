# V11 MCP 共享与远程访问开发记录

交付版本：桌面应用 1.9.0，共享契约包 0.4.0，Preload bridge 11。

## 配置与生命周期

共享页按内容、能力、远程连接、ChatGPT、诊断、高级设置排列。`mcp-sharing.json` 是共享根、工具权限、本机 Endpoint 和分析开关的配置来源；远程 Provider 使用独立的 V2 配置。旧版本的公网项目子集迁移为 custom，避免升级后扩大共享范围。外部协议继续使用稳定的 `workspace_id`。

额外文件夹必须经主进程目录选择器授权，实时检查真实路径、可读性与链接目标变化。磁盘根、用户 Home 和系统目录不允许作为共享根。既有项目与额外文件夹可在真实路径一致时关联。

Remote service 持有共同的 Public Ingress。Provider 只负责建立和停止自己的连接；OpenAI 实验通道也转发到同一入口。共享根、只读工具和公网子集保存后立即生效，不要求重启 Provider。端口、程序、域名等连接参数标记为待重连。诊断失败降级为 degraded，不终止仍存活的连接。

Secret 与连接地址指纹分别持久化；普通保存不会轮换 Secret。工具指纹依据定义计算，不包含共享根列表。界面只有在用户确认已 Scan Tools / Refresh 后才记录扫描基线。

## 分析任务边界

默认关闭；启用时必须选择已配置的渠道与模型。四个分析服务工具独立于本地原子工具注册表，复用现有 Pi headless runtime。分析运行只注入白名单只读工具，禁止原生 Shell、写入、其他 MCP、项目 Skills 和递归任务。

队列最多一个执行、三个等待；每分钟限制六次启动，并对重复指令去重。取消和撤权会通知运行器；重启后未完成任务标记中断，不自动重新调用模型。任务快照不导出原始指令或内部日志。记录保存失败会输出不含私密内容的错误，不阻塞后续队列执行。

Git 读取禁用 fsmonitor、外部 diff、textconv 和 clean/smudge/process filters，并检查仓库根，防止工具触发本地执行或读取上级仓库。

## Provider 验证范围

- Cloudflare Quick：用户在 V11 需求文档中反馈，真实 ChatGPT Scan Tools 与工具调用已通过。这是用户验收记录，不是本轮新增浏览器自动化结果。
- Cloudflare Named、ngrok、External HTTPS：实现与脚本测试覆盖，真实账号和公网 ChatGPT 验收仍待完成，不标为已验证。
- Tailscale Funnel：Beta；官方签名 CLI 1.102.3 的参数已核对，未安装服务或更改设备网络。使用受管前台进程，拒绝覆盖已有 Funnel 443 配置；停止时只结束自身进程。
- ngrok：本机 3.39.9-msix-stable 的命令参数及 V3 配置检查通过。Token 仅通过环境传递，不进入命令行。
- OpenAI Secure Tunnel：实验性选项，仅选中时显示专属配置。

## 可复用验证

```powershell
bun run typecheck
bun test
bun run --filter='@proma/electron' test:mcp-sharing
bun run --filter='@proma/electron' test:mcp-transport
bun run electron:build
bun run --filter='@proma/electron' smoke:renderer-dist
bun run --filter='@proma/electron' smoke:mcp-bundle (Resolve-Path 'node_modules/electron/dist/electron.exe').Path
bun run --filter='@proma/electron' test:mcp-ui
```

`test:mcp-ui` 提供 localhost:5190/__sharing-ui 的模拟页面，使用真实组件和模拟 IPC，不进入生产 renderer。队列、热更新和 Provider 测试使用模拟运行器/子进程和隔离目录，不调用付费模型。

人工验收需覆盖安装后设置页、真实 ChatGPT 扫描、渠道模型选择、分析取消与重启，以及拟使用的固定域名 Provider。自动化脚本通过不等于这些人工验收已通过。

2026-09-10 本地验证：662 项测试、1592 个断言通过，类型检查通过；生产构建通过，780 个 renderer 产物文件扫描通过。Electron 43.2.0 / Node 24.18.0 下 Local + Public MCP CJS 冒烟通过。图形浏览器控制连接失败，未将模拟页面交互记为通过。

## v1.9.0 Actions 故障与 v1.9.1 修复验证

运行 34375933911 在 Windows runner 的 Git 只读测试及两个官方 Client 用例失败，未进入多平台打包。v1.9.0 保持草稿。根目录校验增加非零文件身份（dev/ino）比较，兼容 Windows TEMP 的 8.3 短名称与 Git 长名称；仍拒绝不同目录和父仓库。同时保留 Git 原始错误以便定位其余环境差异。短路径是当前排查方向，最终是否解决以新 Actions 结果为准，不能仅凭本地通过宣告修复。修复后的五个相关本地测试已通过。
