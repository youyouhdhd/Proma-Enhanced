# V10 Transport 解耦前置验证

基线：v1.7.2 / c45b6aec。目标交付：应用 1.8.0，共享契约 0.3.0，bridge 10。

2026-09-09 用户明确调整顺序为“先完成功能开发，安装后人工验收”。因此 ChatGPT Scan Tools 不再阻止本轮功能开发与安装用测试版交付；真实 ChatGPT / Named 重启复用仍单独标为待人工验收，不伪称已通过。

## Gate A：用户提供的隔离实验

V10 需求文档给出：官方 embedded MCP stub 在 tunnel-client 0.0.13/0.0.14 下可完成 Discovery，但 ChatGPT 未下发 tools/list。该现象与 [openai/tunnel-client #57](https://github.com/openai/tunnel-client/issues/57) 一致。2026-09-09 查询时该 issue 仍开放，报告也明确没有确认最终根因。

本轮不重复改写 MCP v2 协议。Secure Tunnel 后续应作为实验性接入方式，遇到 Hosted discovery stalled 时建议 Public HTTPS；不把个别场景推广为所有账户必然失败。

## Gate B0：已执行的自动验证

- 系统 PATH、常用安装目录、Downloads/Desktop 和项目目录均未找到 cloudflared。
- 用户明确产品允许自行选择程序；产品不新增下载器，不修改系统 PATH。
- 为开发验证，将官方 cloudflared 2026.8.3 Windows amd64 文件临时下载到 apps/electron/out/v10-tools。
- 执行前 SHA256 已与 GitHub 官方资产 digest 核对：83E726ED18EA78C5AD5213C4C3A3A27051393950D2BC8ED4DE69BEC12D14EAAE。
- 已运行该文件的 --version、tunnel --help、tunnel run --help；确认 Quick 的 --url、--http-host-header、--no-autoupdate，以及 Named 的 TUNNEL_TOKEN 环境变量契约。
- [Cloudflare Quick 官方说明](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)用于核对测试用途与随机 URL 生命周期。

测试脚本位于 apps/electron/out/v10-gate-b0.ts，仅作为临时验证夹具。复用现有 createModernServer 和 LocalToolRegistry，不改产品协议核心或注册 TransportProvider。

隔离条件：新建演示 workspace，只有 README 与无提交的小型 Git 仓库；仅暴露 workspace_list、workspace_info、read_file、git_status、search_text 五个只读工具；拒绝 Legacy/Session；只监听 127.0.0.1。Cloudflare 的临时 HOME 是演示 workspace 的兄弟目录，不能被 MCP 文件工具读取。

Quick 命令使用当前 help 确认的参数：

```text
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port> --http-host-header 127.0.0.1:<port>
```

Host 重写发生在 Transport，不改 Proma Host 校验。未使用 no-tls-verify，也未公开真实仓库、HOME 或整个磁盘。

| 验证层 | 结果 |
| --- | --- |
| 本地官方 Client modern | PASS |
| 本地 tools/list，固定 5 个工具 | PASS |
| 本地 workspace_list / read_file / git_status | PASS |
| Quick HTTPS URL 生成 | PASS |
| 公网官方 Client modern | PASS |
| 公网 tools/list，固定 5 个工具 | PASS |
| 公网 workspace_list / read_file / git_status | PASS |
| ChatGPT Scan Tools / App 创建 | 未取得结果 |
| ChatGPT 工具调用 | 未取得结果 |

日志 apps/electron/out/v10-gate-b0.log 含 LOCAL_OFFICIAL_CLIENT_PASS、PUBLIC_OFFICIAL_CLIENT_PASS、SMOKE_CLOSED。短时 endpoint 已自动关闭，旧随机 URL 不可继续用于测试。探测初次等待后成功，不将最初尚未注册的公网 URL 判定为协议错误。

本轮能够发现 ChatGPT 标签页，但浏览器控制读取页面超时。已经请求人工 Scan Tools 验证；缺少人工结果不能宣称 Gate B0 全部通过，也不能据此判定 ChatGPT 失败。

## 已完成的独立 P0 改动

移除未经验证的 OpenAI release.json 自动安装实现。普通 UI 不再提供自动管理/安装按钮，提供 PATH 与选择已有 full CLI。旧托管缓存仅作兼容输入；旧 bridge 安装调用返回 TUNNEL_CLIENT_INSTALL_DISABLED，不发网络请求，不重置已有运行连接。默认新配置使用 system-path。

新增“不访问网络”的安装停用回归。完成全套功能后全量测试 649 项通过，类型检查通过。

## 后续门禁与工作清单

- [x] Gate A 证据边界与现有参考核对。
- [x] Gate B0 本地与公网官方 Client、只读工具执行。
- [x] 停用错误的 OpenAI 自动安装来源。
- [ ] Gate B0 ChatGPT Scan Tools 与实际读取演示文件。
- [x] Modern-only Public Ingress、secret URL、固定 public-readonly。
- [x] TransportProvider、Cloudflare Quick 产品化及选择程序界面；真实产品 Quick 公网验证通过。
- [x] Named、稳定端口、safeStorage token、模拟重启复用回归；真实域名复用待人工验收。
- [x] OpenAI Secure 实验性 Provider 与代理边界。
- [x] V10 生产构建、Windows 完整打包、renderer 两级扫描和 Local/Public CJS 冒烟；包内 997 个构建文件与最终 dist 一致。
- [ ] CI 与预发布结果：提交后记录在 GitHub Release。
- [ ] 安装后真实 ChatGPT / Named 验收（按用户调整后的顺序执行）。

按用户明确调整后的顺序交付安装测试版；不宣称第 32 节的真实 ChatGPT 与 Named Gate 已通过。

## 产品实现与工程边界

- mcp-transport 提供统一 preflight/start/stop/getStatus/diagnose 契约。Quick/Named 共用进程管理；Local/OpenAI 适配既有服务。Transport 不注册工具。
- configured-tools.ts 从既有 Local Server 提取同一套工具分发，Public 和 Local 共同使用 LocalToolRegistry、工作区解析及权限判断。未更改 SDK 版本、Discovery schema 或 V9 request classifier。
- Public Ingress 独立绑定 127.0.0.1 的固定端口（默认 8787）；冲突明确返回 PUBLIC_INGRESS_PORT_IN_USE。仅允许 modern stateless；错误 Secret 为404；GET/DELETE/Legacy/Session 不进入旧适配器。
- Public 固定 10 个只读工具，列表与调用双重裁剪。用户单独勾选公网项目，默认不公开任何项目；每次调用与内部 enabled/read 权限取交集，目录在调用时重新解析。
- Connector Secret 为 32 字节 CSPRNG 的 base64url，首次生成后 safeStorage 加密持久化。解密失败不静默重新生成。Named token 同样使用 safeStorage，只在 TUNNEL_TOKEN 环境变量中传递。Linux basic_text 后端不用于保存新凭据。
- 配置独立写入 mcp-remote-access.json，采用 safe-file 原子写入；只保存模式、端口、域名、程序路径、工作区ID和自动恢复偏好，不保存 Secret/token。新配置损坏时回退 Local，不从旧备份自动恢复公网自动启动。
- 未创建新配置时兼容既有 OpenAI 配置与已启用的自动恢复；新配置保存后以新的 mode/autoStart 为准。启动顺序统一为 Local 后 Remote，避免重复并发启动；退出时关闭子进程及端口。
- cloudflared 使用显式临时空配置与独立 HOME，避免继承全局 ingress 指向其他本地服务；PATH/custom path 检测，shell:false、windowsHide、no-autoupdate，完整 token/Secret 不进入 argv 或诊断。
- Ready 必须通过公网官方 Client 的 modern、10 个只读工具、workspace_list 检查。启动可取消；迟到结果不复活已停止连接；进程退出清空 Ready。手动连通性复检失败会停止连接。
- renderer 仅接收脱敏 Server URL。复制按钮调用专用 IPC，由主进程解密并写剪贴板，IPC 不返回完整 URL。Public trace 固定 /mcp/<redacted>，方法名采用白名单，不保存参数和响应内容。
- 控制面代理只配置到 OpenAI Provider，run/doctor 一致使用 CONTROL_PLANE_HTTP_PROXY，并将本机加入 NO_PROXY；不把 OpenAI 凭据/代理传给 cloudflared。
- Public 界面区分 Named 日常、Quick 测试、OpenAI 实验性和 Local；保留既有项目管理及 V9 诊断在可展开区域。OpenAI Discovery 成功后持续缺少 tools/list 时显示 UPSTREAM_HOSTED_DISCOVERY_STALLED。

## 产品 Quick 实测与回归

apps/electron/out/v10-product-smoke.ts 使用真实产品 CloudflareProvider + PublicMcpIngress + configured-tools，只绑定新建的演示 workspace。
已经取得 V10 PRODUCT QUICK PASS：modern、10 个只读工具、workspace_list/read_file/git_status；状态中没有完整 Secret。显式隔离 cloudflared 全局配置后再次通过。测试结束记录 PUBLIC_SMOKE_STOPPED。

新增回归覆盖正确/错误 Secret、写入工具直接调用拒绝、Legacy 拒绝、端口冲突、路径越界、授权撤销、Quick URL解析、缺程序、缺token、进程退出、超时、探测失败、停止竞争、Named域名复用、加密存储与解密失败。649 项全量测试通过。CJS/Electron 冒烟已扩展为 Local + Public 双路径。

最终复核增加了运行中 Secret 丢失的拒绝保护；本地最终交付包位于 apps/electron/out/v1.8.0-final，997 个包内构建文件与最终 dist 哈希一致。Electron 43.2.0 / Node 24.18.0 下 Local + Public 冒烟通过，renderer 扫描为 420 个源码文件与 780 个产物文件。

```powershell
bun install --frozen-lockfile
bun run --filter='@proma/electron' prepare:electron
bun run typecheck
bun test
bun run --filter='@proma/electron' test:mcp-public-ingress
bun run --filter='@proma/electron' test:mcp-transport
bun run electron:build
bun run --filter='@proma/electron' check:renderer-boundaries
bun run --filter='@proma/electron' smoke:renderer-dist
# apps/electron 内，完整打包：
bun run dist:win --publish never '--config.directories.output=out/v1.8.0'
```

## 安装后人工验收

1. 完全退出旧 Proma 后安装测试版。准备用户自行下载的官方 cloudflared，在“远程 MCP”选择 PATH 或本机程序。
2. 在下方项目管理中添加并启用读取权限，刷新公网项目列表，只勾选希望公开的项目。
3. 先选择 Quick 启动，等待 Public MCP Probe 通过，点击复制 Server URL；ChatGPT 选择 Server URL / No Authentication，Scan Tools 后测试 workspace_list、README和Git状态。
4. 日常使用选择 Named，填写稳定域名及 Cloudflare Tunnel Token；Cloudflare Published Application origin 指向界面显示的固定 localhost 端口。
5. 启动成功后复制新URL配置ChatGPT，停止/重启Proma再启动同一Named连接（或显式启用自动恢复），确认同一hostname和Secret无需重建App。
6. 需要撤销旧URL时轮换Secret；这会停止连接并使旧URL失效，需在ChatGPT更新。工具有变化时使用ChatGPT Refresh。

## 临时目录清理记录

首次本地测试夹具的 C:\Temp\proma-gate-b0-4Xypu2 清理被自动审批以 blocked by policy 拦截，已保留，未换用其他方式删除。后续夹具改在仓库 out 内创建并在短时测试结束时清理。该遗留目录只有非敏感演示数据。
