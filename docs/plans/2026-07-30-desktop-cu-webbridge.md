# Desktop 接入 Computer Use 与 WebBridge — 调研与方案对比

日期：2026-07-30。状态：**Phase 0 已实现并通真机 e2e（最终命名与货架钩子已就位）**：

- **kimi-code 上游**：PR [#2407](https://github.com/MoonshotAI/kimi-code/pull/2407)（3 commits：capability 域+路由、改名避让、正名替换+货架钩子），CI 绿。capability 域 + `routes/capabilities.ts`（3 路由，轮询进度，错误码 40418/40922/40923）+ changeset。
- **命名终局（需求方拍板）**：我方使用-skill 插件**正名 `kimi-webbridge`、版本与上游 skill 对齐（1.11.3），刻意替换**生产上另一团队的 guide 插件（v3.0.4，install/remove 引导 skill）——guide 用户重装/升级即迁移到真使用-skill。版本号曾误造 4.0.0 已被纠正为与上游一致。中间态曾用名 kimi-webbridge-skill（commit 2），commit 3 改回正名。
- **kimi-cu 上货架**：marketplace 条目 `source` 直指 CU 团队 CDN zip（不重打包）；**不配置版本号**——schema 本就允许（superpowers/vercel-plugin 同例），货架/更新提示一律按需用已装插件 manifest 的实测版本（`computeUpdateStatus` 只在双端都是合法 semver 且 latest>local 才报 update），杜绝手写编号漂移。kimi-webbridge 条目版本由构建自动从 manifest 盖戳（1.11.3）。
- **货架安装钩子（hack 落地）**：`CapabilityService` 订阅 `IPluginService.onDidReload`——任意路径（货架/TUI/CLI）把某能力的接线层装成 ok 且二进制层缺失时，自动补装二进制（KimiCU.app + 服务 / WebBridge daemon）。只在 false→true 边沿触发，权限未授等人工步骤缺失不会造成重复下载。
- **真机 e2e（最终代码复验）**：kimi-cu ready（4 步全 ok，0.4.18）；kimi-webbridge 经本地市场 zip 安装 → ready（skill 1.11.3，daemon v1.11.3）。真实 reinstall 的 skill 步骤在 `plugins/cdn` 重新发布前会 404（kimi-cu 全链路走真实 CDN 无此问题）。
- **本仓（未提交）**：submodule → `9fcaf3f7a`（origin 分支可解析，PR 合入后改指 origin/main）；web-core capabilities client（+5 测试）；desktop 适配上游 identity 重构；pnpm-lock 同步。全量 148 文件 2217 测试全过、双端 typecheck 通过。
- **Phase 3 已完成（2026-07-30）**：上游 plugins REST 路由（`GET /plugins`、`GET /plugins/marketplace`（目录与安装态服务端合并、严格 semver updateAvailable）、`POST /plugins {source}`、`:enable`/`:disable`/`:remove`，40419；marketplace URL 走 server 选项/`KIMI_CODE_PLUGIN_MARKETPLACE_URL` env/生产默认）+ desktop 设置「插件」页（PluginsPanel 货架 UI + usePlugins 单例，老 server 无路由自动隐藏）+ web-core client。验证：路由 e2e 4、client 5、composable 7；亮/暗双主题 CDP 截图；真机 UI 全流程（UI 内移除并重装 kimi-cu，upsert 装到 latest 0.5.4；货架钩子在二进制就绪时正确 no-op）。注：desktop 未打包构建开启 `/api/v1/debug` 反射面便于手动驱动（生产恒关）。
- **安装进度可视化（2026-07-30，已落地）**：capability 安装不再静默——TUI `/plugins` 安装 capability 条目改走 capability 面（面板内联行实时显示步骤+百分比，结果行报 ready/失败重试/后台继续），klient global facade + node-sdk v2 + Session 打通 capabilityService（v1 引擎明确报不支持）；desktop 货架安装走 `:install` 路由并轮询，行内实时进度（下载中 N% / 启动后台服务…），失败落行内错误。capability 移除在两端都明确提示「运行环境已保留/二进制未动」。已实测：全新环境下 webbridge 安装全程可见（下载中 0→87% → 启动服务 → ready）。
- **待办**：PR 合入 → submodule 指 origin/main；`plugins/cdn` 重新发布（marketplace 出现 kimi-webbridge 1.11.3 + kimi-cu（无版本号条目）；guide 插件被替换）；Phase 1 desktop 能力卡片 UI。
- 实现期新验证：`installPlugin` 对已装 id 是 upsert 覆盖（`manager.ts:135-160`）——「重新安装」语义成立。

范围：两个能力一起做，**kimi-cu 先行**；同一套「能力安装」框架复用到 WebBridge。

## 1. 背景与目标

让 kimi-code-app（Electron 桌面端）的用户在应用内一键启用两种 Agent 能力：

- **Kimi Computer Use（kimi-cu）**：macOS 后台 GUI 操作（AX 树 + 截图 + 后台点击/输入/滚动），不抢鼠标、不切前台。
- **Kimi WebBridge**：让 Agent 操作用户真实浏览器（带登录态），导航/点击/填表/截图/抓数据。

现状：TUI（kimi-code CLI）只在插件选择器里硬编码了一个 WebBridge 推广位，选中后打开网页
（`kimi-code/apps/kimi-code/src/tui/components/dialogs/plugins-selector.ts:35`）。
本次要求 desktop **内置安装**：点击安装时直接下载 CDN 产物并接线，不再跳外链。

**已确认的决策**：

- 方案按**能力分层**选择，不是一刀切（评审第一轮）。
- 插件管理层走**方案 B**：kimi-code 上游 kap-server 新增插件管理 REST 路由（评审第一轮）——插件管理是 agent 核心能力的本质归属，TUI/web/desktop 三端共享。
- **WebBridge 的 daemon/skill 层与 kimi-cu 的 App 二进制层一并上游化**（评审第二轮）：以「内置能力（built-in capabilities）」注册表 + kap-server capabilities 路由的形式放进 kimi-code，desktop 只保留纯 UI 与引导。理由：
  1. 这些层全是本机文件 + spawn 级操作（免 sudo、无 GUI 依赖），server 侧完全做得；web 端（浏览器 UI + 本机 daemon server）因此同样受益；
  2. TUI 的硬编码 WebBridge 外链推广位本质就是该能力的占位符——上游有了正式安装路由，CLI 的"把 curl 命令贴给 agent"安装方式才能升级成真安装，三端统一；
  3. 一处实现承载平台探测 / CDN 布局 / Kimi Work 共存规则，避免 desktop/web/CLI 各自漂移。
- 真正留在 desktop 的只有纯 UI 碎片：能力卡片、进度渲染、浏览器扩展引导页、kimi-cu 权限引导图文。
- **本质抽象定稿**（评审第三轮，第六轮修订接线基材）：**capability = 一个二进制运行时 + 一份接线 + 若干人工步骤**，两条目完全同构——kimi-cu = KimiCU.app + 插件 zip 接线 + TCC 权限（硬门槛）；WebBridge = daemon + 官方插件接线 + Chrome 扩展（软门槛，流程提示 + 使用时官方报错兜底，不阻塞「就绪」）。插件体系管两个能力的接线（它唯一擅长的），二进制生命周期一律由 capability 编排第三方自带机读工具。
- **v1 不维护版本升级**（评审第三轮）：不做 "update available" 检测（省掉 CDN 版本清单依赖与 zip-url 更新检测上游化）；升级路径 = kimi-cu 幂等重装 / WebBridge 官方 `kimi-webbridge upgrade`（二进制+skill 同步）；UI 只展示版本号 +「重新安装/修复」按钮。
- **WebBridge 接线走官方插件包**（评审第六轮，取代第三轮"不打插件包"）：需求方确认"我们是官方但 WebBridge 是兄弟团队做的，**不进他们的发布流水线**，允许短期漂移，速度优先"。落法：**自维护 `kimi-code/plugins/official/kimi-webbridge`**（kimi-datasource 先例），skill 内容从官方拷贝、随需要手动 bump——漂移方向安全（skill↔扩展契约中 skill 偏旧不触发失配错误，只缺新功能）。打包发布机制现成：`build-plugin-marketplace-cdn.mjs` 自动 zip 化官方插件并改写 marketplace source，生产目录已在 `code.kimi.com/kimi-code/plugins/`（marketplace.json + official/*.zip 已核实在线）。**零跨团队依赖**。两能力由此对称：**capability（二进制）+ plugin（接线）**。daemon 本体仍不进插件（声明式消费模型不承载长驻 HTTP daemon）。注意 skill 源优先级 `user(20) > plugin(5)`（`skillSource.ts:25`）：走插件接线时必须清理 `install-skill` 写过的 user 源旧副本，否则插件被遮蔽。
- **通用 plugins REST 路由延后**（评审第三轮）：本需求没有"管理任意插件"的消费方（capability 路由进程内直调 `IPluginService` 装 kimi-cu 插件包，UI 状态全走 capability status）；等插件市场 UI 立项时再加（klient 契约现成）。capability 路由本身就是方案 B 的落地，此为范围精化而非方向变更。
- 三个开放问题已自行验证（见 §6）。

参考资料：

- 飞书《Kimi Computer Use》介绍文档（功能特点 + 安装方式；已通过 WebBridge 读取）。
- https://www.kimi.com/zh-cn/features/webbridge —— 官方架构说明：本地桥接服务 + 浏览器扩展（CDP），全部本地执行。

## 2. 两个能力的本质拆解

### 2.1 kimi-cu（macOS only）

| 层 | 内容 | 安装方式 |
|---|---|---|
| 插件包层 | 标准 managed plugin：`kimi.plugin.json`（stdio MCP `mac` + skills）+ `bin/kimi-cu-mcp` wrapper（转发到 KimiCU.app，因 stdio 插件 command 只允许 PATH 命令或 `./` 相对路径） | `https://cdn.kimi.com/kimi-computer-use/latest/kimi-cu-plugin.zip`，`IPluginService.installPlugin`（zip-url 源，本机 installed.json 已有成功记录） |
| App 二进制层 | KimiCU.app → `/Applications`，注册 launchd 服务（`ai.kimi.cu.service`），官方脚本 `setup_macos.sh`（/Applications 不可写时 sudo） | 下载 + 解压 + 服务注册，纯 spawn 级操作（提权经 osascript 也可 spawn） |
| 权限层 | 辅助功能 + 屏幕录制，TCC 授予对象是 KimiCU.app 自身（与父进程无关），用户手动开关 | 弹窗 + 状态可机读（见 §6） |

生效链路：插件装进 managed 目录后，MCP server 进入 `enabledMcpServers()`，**新会话**创建时自动挂载；进行中的会话不追溯。

### 2.2 WebBridge（macOS / Linux / Windows）

**不是插件**，三层：

| 层 | 内容 | 安装方式 |
|---|---|---|
| daemon 层 | `kimi-webbridge` 二进制 → `~/.kimi-webbridge/bin/`，本地 HTTP daemon `127.0.0.1:10086`（端口单实例），**免 sudo 免 GUI**；`/status` 可查 `{running, version, extension_connected, extension_id, uptime}` | `cdn.kimi.com/webbridge/<ver\|latest>/releases/kimi-webbridge-<platform>` + `start` |
| skill 层 | SKILL.md + references → `~/.kimi-code/skills/kimi-webbridge/`（user-scope，会话经 kap-server 五源技能目录自动发现） | `kimi-webbridge install-skill -y`（幂等） |
| 浏览器扩展层 | Chrome/Edge 扩展（CDP 执行端），webstore id `fldmhceldgbpfpkbgopacenieobmligc`；**另有手动安装包** `https://kimi-web-img.moonshot.cn/webbridge/latest/extension/kimi-webbridge-extension.zip`（官网「手动安装」入口，webstore 不可达时的官方退路，拖入 `chrome://extensions`） | 只能用户在浏览器内完成（UI 引导，软门槛） |

**官网「搭配本地 Agent」官方安装流**（页面内嵌 JSON 已核实，我们的 capability 安装器就是对它的内置化）：

1. 第 1 步「安装浏览器拓展插件」：webstore 或手动 zip 两条路径，每步带「我已安装 / 跳过」。
2. 第 2 步「在你的 Agent 中连接 Kimi WebBridge」：让用户把指令贴给 Agent——`安装 Kimi WebBridge: curl -fsSL https://cdn.kimi.com/webbridge/install.sh | bash。装完后即可操作我的浏览器完成任务了`（Win：`irm https://cdn.kimi.com/webbridge/install.ps1 | iex`），即 **agent 自己跑 curl|bash**；成功文案"已连接 Kimi WebBridge。重启你的 Agent……"。
3. 官网支持多个 agent 工具——kimi-code 是一等支持对象，`install-skill` 会检测 runtime。

对我们的含义：desktop 的「安装」按钮 = 官方第 2 步的原生替代（直接下载 CDN 产物，不再让 agent 跑脚本）；官方"重启 Agent"在 desktop 不需要（技能目录按会话构建，**新会话生效**）；扩展手动 zip 路径必须进引导 UI（webstore 对网络受限用户不可达）。

运行方式：Agent 按 skill 指引用 Bash + curl 打 daemon 的 `POST /command`——**不依赖 MCP**。
**共存约束**（官方 operations.md 明示）：Kimi Work 桌面版托管自己的 daemon，外部进程**不得 stop/restart/uninstall**，只能 start-if-down。能力路由必须内置同样规则。

## 3. 现状盘点（desktop / 上游承载点）

- **插件服务已存在且契约完整**：`IPluginService`（`agent-core-v2/src/app/plugin/pluginService.ts`）提供 `installPlugin / listPlugins / setPluginEnabled / removePlugin / reloadPlugins / getPluginInfo / checkUpdates`；wire schema 在 `klient/src/contract/global/plugins.ts`（zod，可映射成 REST 输入输出）。
- **kap-server 没有插件管理 REST 路由**：`/api/v1` 下只有 skills 只读路由（`routes/skills.ts`，边缘组合模式 + action 后缀 + envelope 错误映射，是新路由的编写范式）。
- **会话消费插件/技能是自动的**：skills 五源目录含 plugin 与 user 源；插件 MCP 在新会话创建时挂载。装好即对**新会话**生效，无需 server 重启。
- **renderer ↔ server 通道**：desktop renderer 与 web 共用 `@moonshot-ai/web-core` 的 daemon client（REST + WS，skills 方法先例在 `client.ts:975+`），新接口按同一模式添加。
- **desktop 主进程基建**：IPC 白名单 preload 模式；双语字符串表（`tray.ts`/`menu.ts`）；`shell.openExternal` 统一外链出口；`net.fetch` 下载先例。
- **renderer 约束**：desktop renderer 是 `apps/web/src` 快照副本，共享文件改动需同步 web 或登记分叉块（`native-todos.md`）；UI 走设计系统 token + 亮暗双主题验证 + `check:style`。
- **外部 server 模式**（`KIMI_SERVER_URL`）：B 方案下天然支持——路由在 server 侧，对面 CLI server 升级后同样有。

## 4. 方案：按能力分层映射（第二轮定稿）

### 4.1 总览

| 能力 | 层 | 方案 | 落点 |
|---|---|---|---|
| kimi-cu | 插件包层 | **B：capability 安装器进程内调 `IPluginService.installPlugin`（CDN zip）** | kimi-code 上游 |
| kimi-cu | App 二进制层 + 服务注册 + 权限状态 | **B：capabilities 路由的内置条目**（macOS-only 安装器模块） | kimi-code 上游 |
| kimi-cu | 权限引导图文 | 纯 UI | desktop renderer |
| WebBridge | daemon 层 | **B：capabilities 路由的内置条目**（三平台安装器模块） | kimi-code 上游 |
| WebBridge | skill 层 | **自维护官方插件**（`kimi-code/plugins/official/kimi-webbridge`，kimi-datasource 先例）经 `installPlugin` 安装（capability 安装器进程内调用；CDN zip 由现成 `build-plugin-marketplace-cdn.mjs` 机制产出） | kimi-code 上游 |
| WebBridge | 浏览器扩展引导 | `openExternal` + 状态轮询展示（软门槛） | desktop renderer + 主进程桥 |

对称结构定稿（评审第五轮）：**两个能力 = capability 条目（管二进制）+ 官方插件包（管接线）+ 人工步骤引导（权限/扩展）**。

### 4.2 kimi-code 上游：内置能力（built-in capabilities）

新增一个小的 capability 域（建议位置 `agent-core-v2/src/app/capability/`）：

- **注册表**：硬编码两个内置条目（不接受任意来源，安全面最小）：
  - `kimi-cu`（macOS）：链路 = `IPluginService.installPlugin(kimi-cu-plugin.zip)` → 下载 `KimiCU.app.zip` 解压到 /Applications（不可写时 osascript 提权）→ `kimi-cu install` 注册服务 → `service-status` + `request-permissions` 状态机。
  - `kimi-webbridge`（三平台）：链路 = 平台探测 → 下载二进制到 `~/.kimi-webbridge/bin/` → `start`（幂等，永不 stop/restart/uninstall）→ `IPluginService.installPlugin(kimi-webbridge 官方插件 zip)`（**替代 `install-skill`**，见下）→ 读 `/status`（running / extension_connected）。
  - 每条实现 `detect()`（分层状态）/ `install()`（幂等可重入，断点续跑）/ `status()`。
  - **WebBridge skill 冲突处理**：skill 源优先级 `user(20) > plugin(5)`——用户若曾跑过官方 install.sh（user 源有 `~/.kimi-code/skills/kimi-webbridge/`），install 时必须删除该旧副本（我们自己的产物，安全），否则插件副本被遮蔽、永远生效不了。`install-skill` 不再调用（它无差别写所有检测到的 runtime；其他 runtime 的用户自行安装）。
- **kap-server 新增 `routes/capabilities.ts`**（仿 `skills.ts` 范式）：
  - `GET /capabilities` → 各条目分层状态（平台不支持的条目标记 unsupported）
  - `POST /capabilities/:id:install` → 触发安装（长任务，进度经 WS 事件推送，复用现有事件广播基建 `sessionEventBroadcaster` 的同类模式）
  - 错误映射沿用 envelope 体系。
- **通用 plugins 路由（`routes/plugins.ts`）本期不做**：没有任何消费方（capability 域进程内直调 `IPluginService` 装 kimi-cu 插件包；UI 状态全走 capability status）。留待插件市场 UI 立项时加，契约现成（klient zod schema 可映射）。
- **TUI 后续可接**：硬编码外链推广位升级为真安装（上游自己的后续 PR，不在本仓范围）。
- 双仓工作流：kimi-code 工作克隆开发 → 合入 → 本仓 bump submodule。

### 4.3 desktop：纯 UI + 引导

- **能力卡片**：设置新 tab「能力 / Capabilities」（`SettingsDialog.vue` 分叉块 + `components/settings/CapabilitiesPanel.vue` desktop-only）。两卡片：分层状态（未安装 / 安装中·进度 / 部分就绪 / 就绪 / 不支持该平台）+ 操作（安装 / 重新检测 / 修复）。数据全部来自 web-core client 的 capabilities/plugins 接口——**desktop renderer 与 web 共享同一份实现，理论上 web 端可直接复用**（首期 web 可只读或隐藏，见分期）。
- **进度展示**：WS 进度事件 → 卡片进度条/步骤文案（双语，i18n key 进共享包 web-i18n）。
- **扩展引导**（WebBridge，**软门槛**）：daemon + skill 装好即算「就绪」；状态含 `extension_connected=false` 时卡片显示「安装浏览器扩展」提示，给**两条官方路径**（对齐官网）：① `shell.openExternal` 打开 webstore 页（复用现有外链通道）；② 手动安装——下载官方 zip（`kimi-web-img.moonshot.cn/webbridge/latest/extension/kimi-webbridge-extension.zip`，经 daemon `will-download` 走系统保存对话框）+ 引导拖入 `chrome://extensions`。轮询状态直到连上，但不阻塞就绪判定；使用时若扩展未装/过旧，skill 约定的官方报错文案兜底引导。
- **权限引导**（kimi-cu）：状态含 `permissions: {accessibility, screenRecording}`（server 侧裸调 `request-permissions` 机读），未全 true 显示引导图文 +「重新检测」。
- **生效提示**：插件装好后提示「对新会话生效」（双语）。
- **遥测**：renderer 点击走 `kimi:track` 白名单；server 侧安装事件上游自带 telemetry 体系。
- web 端：路由天然可用；UI 是否同步展示在 Phase 2 评审（能力卡片若做成共享组件则零额外成本——这是 B 的直接红利）。

### 4.4 被否决的替代方案

| 方案 | 否决原因 |
|---|---|
| C. 主进程自写 managed 目录 + installed.json + 重启 server | 绕过 PluginManager 手写状态文件，格式漂移即坏；重启断所有会话 |
| D. shell-out 官方安装脚本（`curl \| bash`） | 无进度、无结构化错误、sudo 卡死无终端；只复刻其逻辑，不调用其形 |
| A. desktop 主进程进程内直调 / 主进程原生安装器 | 只覆盖内嵌 server 与 desktop 一端；WebBridge daemon/skill 层免 sudo 无 GUI，没有非主进程不可的理由（第二轮评审后否决，保留记录） |

## 5. 关键设计点

### 5.1 kimi-cu 安装流（server 侧 orchestration）

1. `installPlugin('https://cdn.kimi.com/kimi-computer-use/latest/kimi-cu-plugin.zip')`（进程内，瞬时）。
2. 下载 `KimiCU.app.zip`（进度事件）→ ditto 解压 → 停旧进程（`uninstall` / `launchctl bootout` / pkill，复刻官方脚本）→ 移到 `/Applications` → `xattr -dr` 去 quarantine。
   - **提权**：常规路径不提权（admin 用户 /Applications 可写）；不可写时 `osascript -e 'do shell script … with administrator privileges'`（系统授权框；内嵌模式下调用进程即 desktop 本体，身份归属正常）→ 再失败返回结构化错误，UI 给手动命令文案。
3. `kimi-cu install` 注册 launchd 服务 + `service-status` 验证（`SMAppService status=1` 可机读）。
4. 权限：`request-permissions --ax --screen` 触发系统弹窗；状态经裸调 `request-permissions` 机读（输出 `permissions: accessibility=true screenRecording=true`，已验证）。
5. 就绪判据：插件 enabled && app 可执行 && 服务在跑 && 两权限 true。

### 5.2 WebBridge 安装流（server 侧）

**复刻 install.sh 的分工**（只重写拿不进度的部分；skill 接线走自维护官方插件，不调 `install-skill`）：

| install.sh 步骤 | 我们的做法 |
|---|---|
| ① 平台探测 + 下载二进制到 `~/.kimi-webbridge/bin/` | server 侧重写：fetch 下载带进度事件、chmod、记录版本 |
| ② `kimi-webbridge start` | spawn 子命令（幂等，只 start-if-down） |
| ③ `kimi-webbridge install-skill -y` | **替换为 `installPlugin(官方插件 zip)`**（`plugins/official/kimi-webbridge`，现成 CDN 机制产出）+ 清理 user 源旧副本（`~/.kimi-code/skills/kimi-webbridge/`，优先级 user(20) > plugin(5)，不清理插件被遮蔽） |

skill 经 plugin 源进五源技能目录，新会话自动发现（kimi-cu 的 skill 同为 plugin 源，两能力对称）。`install-skill` 不再调用（它无差别写所有检测到的 runtime；其他 runtime 的用户自行安装）。

1. 平台探测（darwin/linux × arm64/amd64；win amd64）→ 解析 `latest` → 下载二进制到 `~/.kimi-webbridge/bin/`（进度事件）→ chmod +x → `kimi-webbridge start`（幂等；**永不 stop/restart/uninstall**，Kimi Work 共存约束写进 capability 条目）。
2. `installPlugin('https://code.kimi.com/kimi-code/plugins/official/kimi-webbridge.zip')`（现成 CDN 目录；URL 以实际发布为准）+ user 源旧副本清理。
3. 状态含 `extension_connected`；false 时由 UI 层引导装扩展（§4.3）。
4. Windows：不跑 `install.ps1`，安装器复刻同逻辑（下载 + start + 插件），不依赖 PowerShell 执行策略。需 Win 真机验证。
5. 版本失配：skill 约定扩展过旧会报错，状态卡给「检查扩展」入口（官方帮助页）。

### 5.3 生命周期管理（版本检测 / 安装 / 更新 / 卸载）

总原则：**插件体系只维护「包」的生命周期；二进制运行时的生命周期由 capability 条目包装第三方自带的机读接口实现**——不自己发明版本管理，只做统一封装（detect / install / status / update / uninstall 语义 + 幂等可重入 + 我们的约束规则）。

两个第三方模块都自带完整的生命周期工具（已实测）：

| 生命周期 | kimi-cu 插件包（插件体系） | KimiCU.app（capability 包装） | WebBridge daemon + skill（capability 包装） |
|---|---|---|---|
| 本地版本检测 | `installed.json` 记录 + manifest version（0.4.18） | 读 `Info.plist` 的 `CFBundleShortVersionString`（0.4.18，与插件**锁步发布**；binary 无 version 子命令，已实测） | `~/.kimi-webbridge/bin/kimi-webbridge.version` 文件（`3.1.1\|size\|ts`）+ `kimi-webbridge status` |
| 远端最新版本 | v1 **不检测**（无 CDN 版本清单，`/latest/version` 404 已实测；不做 update-available） | 同左 | v1 **不检测**；CDN `latest` 目录即当前版本 |
| 安装 | `installPlugin`（zip-url） | 下载解压 + 服务注册（复刻官方脚本） | daemon：下载 + `start`；skill：`installPlugin`（官方插件 zip）+ user 源旧副本清理 |
| 更新（v1 = 用户主动触发） | 「重新安装」（`installPlugin` 对已装 id 是 **upsert 覆盖**：替换 managed 副本、保留 enabled/installedAt、更新 updatedAt，失败自动回滚——`manager.ts:135-160` 已验证） | 重跑幂等安装流（拉 latest） | daemon：官方 `kimi-webbridge upgrade`（优先调它，不重造）；skill：重装插件（手动 bump 仓内副本后随版本发布，漂移可接受） |
| 卸载 | `removePlugin` | `kimi-cu uninstall`（官方脚本同款，注销 launchd 服务）+ 移出 /Applications | `removePlugin` 移除 skill；daemon 共存约束下**不自动 uninstall**（`stop/restart/uninstall` 子命令存在但永不自动调） |
| 运行状态 | enabled/state（installed.json） | `service-status`（`SMAppService status=1`）+ `request-permissions`（机读权限） | daemon `/status`（running/version/extension_connected） |

**版本同步设计**（第六轮修订）：真正强绑定的版本契约是 **skill ↔ 浏览器扩展**（skill 比扩展新才报失配错误），skill↔daemon 本就两套版本号。自维护插件包的 skill 偏旧是**安全方向**（不触发失配，只缺新功能），短期漂移可接受； bump 仓内副本随 kimi-code 版本发布即可。kimi-cu 侧插件包与 App 锁步发布、版本号一致，无此问题。

## 6. 开放问题 → 已自答（2026-07-30）

| 问题 | 结论 | 依据 |
|---|---|---|
| kimi-cu 权限状态可查吗 | **可查**：裸调 `kimi-cu request-permissions` 输出 `permissions: accessibility=true screenRecording=true`，不弹窗 | 本机实测 |
| zip-url 插件有更新检测吗 | **没有**：`PluginManager.checkUpdates` 只处理 `source === 'github'` | `manager.ts:229-246` |
| /Applications 提权怎么做 | 常规不提权；不可写时 osascript 系统授权框 fallback（server spawn 即可，内嵌模式进程身份即 desktop）；再失败给手动命令 | 设计决策 |
| WebBridge 为什么不放 desktop 主进程 | **已改为放上游**（第二轮评审）：免 sudo 无 GUI 纯 spawn，server 侧完全做得；web/CLI 同受益；TUI 外链占位符升级 | 见 §4 |
| Kimi Work 共存 | 只 start-if-down，永不 stop/restart/uninstall，写进 capability 条目 | 官方 operations.md |
| WebBridge 打插件包可行吗 | **采纳（第六轮定稿，实现期改名为 `kimi-webbridge-skill`）**：自维护 `kimi-code/plugins/official/kimi-webbridge-skill`（kimi-datasource 先例 + 现成 CDN 打包机制），skill 从官方拷贝、漂移可接受且方向安全。前提澄清：我们是官方但 WebBridge 属兄弟团队，**不进对方流水线**。实现期发现生产 CDN 已有另一团队的 `kimi-webbridge` guide 插件（v3.0.4，install/remove 引导 skill，zip 在同名路径）→ 改名避让，不撞 id 不覆盖。仍否决的：包 daemon 二进制、MCP 包装 daemon（平行集成）、插件当安装器。冲突处理：user 源优先级(20) > plugin(5)，install 时必须清理 `install-skill` 旧副本 | 评审第六轮 + 实现期修正 |
| 为什么 marketplace 只登记 webbridge-skill 不登记 kimi-cu | marketplace.json 是**浏览目录**而非安装前提（capability 两条目都走硬编码官方 zip URL）。kimi-cu 已有 CU 团队 CDN 的官方插件分发，无需我们托管；WebBridge 没有使用-skill 分发（guide 插件 ≠ 使用 skill），必须自建。kimi-cu 已上货架（`source` 直指 CU CDN zip，不配置版本号、按需检测），且经货架钩子安装即完整安装（自动补装二进制），不再是半残 | 评审问答（2026-07-30） |
| WebBridge skill 装到哪 | `~/.kimi-code/skills/kimi-webbridge/`（user-scope，会话自动发现） | 本机实测 + kap-server 五源目录 |

## 7. 分期计划

- **Phase 0（上游，本需求主体）**：kimi-code 工作克隆实现——① capability 域（`kimi-cu` / `kimi-webbridge` 两内置条目：detect / install / status，幂等可重入，生命周期编排第三方自带工具）+ `routes/capabilities.ts` + web-core client 方法；② **制作 `plugins/official/kimi-webbridge`**（`kimi.plugin.json` + 拷贝官方 skill 内容，版本号随所拷 skill）+ `plugins/marketplace.json` 登记（现成 CDN 打包机制自动 zip 化）。上游 PR 合入后回本仓 bump submodule。**不含**通用 plugins 路由（延后，见 §1 决策）。
- **Phase 1（desktop kimi-cu 卡片）**：设置 tab + 能力卡片 UI + 进度/TCC 权限硬引导 + 双语 + 遥测 + `native-todos.md` 登记；macOS 真机验证。
- **Phase 2（WebBridge 卡片 + 扩展软提示）**：mac 先行，Windows/Linux 真机验证随后；评审 web 端能力卡片是否直接复用（B 的红利）。
- **Phase 3（可选）**：通用 plugins REST 路由 + 插件市场 UI；update-available 检测（需 CDN 版本清单 + zip-url 更新检测上游化）；卸载流（**已决定不做，2026-07-30**：只拆接线即最终语义——默认动作保守可逆、不砸共享二进制、TCC 单向门永不动；运行时清理走手动路径或官方 `kimi-cu uninstall` / `kimi-webbridge uninstall`，不做应用内完全卸载动词）；**TUI 硬编码 WebBridge 推广位让位——已完成（`262bdaa15`）**：catalog 真条目赢（可安装），promo 仅作 loading/error/无条目时的 fallback，页脚计数维持 catalog-only；WebBridge 官方 MCP 包装（跨团队，纯增量）。

## 8. 测试与验证

**手动验证 playbook（2026-07-30 修订版）**：

- **状态检测**：`curl http://127.0.0.1:<port>/api/v1/capabilities`（port 取 dev 日志 "embedded server listening"）。期望 kimi-cu ready（0.4.18 四步 ok）、kimi-webbridge ready（skill 1.11.3）。错误面：未知 id→40418，裸 id/错误 action→40001。
- **desktop 内驱动插件流程（dev-only）**：未打包构建已开启 kap-server 的 `/api/v1/debug` 反射 RPC 面（`debugEndpoints: !app.isPackaged`，生产恒关）——`GET /api/v1/debug/channels` 列出全部 service；`POST /api/v1/debug/pluginService/{installPlugin,removePlugin,...}` body 为对应 input，可模拟货架安装并观察钩子自动补装（已实测：removePlugin → 制造二进制缺失 → installPlugin → 钩子自动下载补齐 → ready）。
- **CLI/TUI 验证（必须从分支/worktree 跑，不能用已装发布版）**：`cd ~/code/kimi-code-capabilities && KIMI_CODE_PLUGIN_MARKETPLACE_URL=http://127.0.0.1:41889/marketplace.json pnpm run dev:cli:v2`（本地市场 server 于 41889）→ TUI `/plugins` Official 页显示 `Kimi WebBridge  install`（非 open in browser）→ Enter 安装 → 该进程内钩子自动补装二进制。注意：在别的分支跑时若仓库 catalog 无此条目，promo 仍会 fallback 显示 open in browser。
- **kimi-cu**：权限开关（系统设置关屏幕录制 → permissions missing detail screenRecording）；会话级：新会话问「看看开了哪些 app」应走 `mcp__plugin-kimi-cu_mac__*` 工具。
- **webbridge**：会话级：让 agent 用 webbridge 开网页截图（真驱动浏览器）。
- **发布前过渡态（已知，不修）**：`plugins/cdn` 未重发期间，真实 URL 的插件步骤会装到 guide 插件（v3.0.4，无使用 skill），detect 的 skill ok 是过渡态假象；重发后 reinstall 即归位 1.11.3。CLI 货架暂看不到新条目；TUI 推广行仍 open-url（follow-up）。
- **marketplace 产物**：`build-plugin-marketplace-cdn.mjs --out-dir` 检查 kimi-cu（无 version）+ kimi-webbridge（1.11.3）；`plugins/cdn` 重发后 production marketplace.json 出现两条目，guide zip 被同名覆盖（无需单独删除）。

**自动化**：

- 上游：capability 域单测（状态机、平台门控、幂等重入、共存守卫、提权回退）；路由测试（仿 skills 路由测试）；web-core client 测试。
- 本仓：renderer composable / 卡片组件测试（无数据降级、进度渲染）；`tests/main/preload.test.ts`（若新增 openExternal invoke）。
- 硬约束：设计系统 token、亮暗双主题视觉验证、`pnpm --filter kimi-code-web run check:style` 无新增 findings、主进程可见文案双语、changeset（patch，只选 `kimi-code-app`）。
- 真机验证清单：全新机完整安装流；已装 CLI 版共存；Kimi Work 共存；/Applications 只读账户（osascript 路径）；安装中断网续跑；新会话出现 `mcp__plugin-kimi-cu_mac__*` 工具与 webbridge 技能；web 端（如启用）走 daemon REST 同样可装。

## 9. 附录：关键坐标

| 内容 | 位置 |
|---|---|
| 插件服务契约 | `kimi-code/packages/agent-core-v2/src/app/plugin/pluginService.ts`、`plugin.ts` |
| wire schema 参照 | `kimi-code/packages/klient/src/contract/global/plugins.ts` |
| 路由编写范式 | `kimi-code/packages/kap-server/src/routes/skills.ts`（边缘组合 + action 后缀 + envelope） |
| WS 事件广播 | `kimi-code/packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts` |
| TUI WebBridge 外链占位 | `kimi-code/apps/kimi-code/src/tui/components/dialogs/plugins-selector.ts:31-50` |
| kimi-cu CDN | `…/kimi-computer-use/latest/{kimi-cu-plugin.zip, KimiCU.app.zip, setup_macos.sh}` |
| WebBridge CDN | `cdn.kimi.com/webbridge/{install.sh, install.ps1, <ver>/releases/kimi-webbridge-<platform>[.exe]}` |
| WebBridge 扩展 | webstore `fldmhceldgbpfpkbgopacenieobmligc`；手动包 `kimi-web-img.moonshot.cn/webbridge/latest/extension/kimi-webbridge-extension.zip` |
| 插件市场 CDN | `code.kimi.com/kimi-code/plugins/marketplace.json` + `official/*.zip`（已核实在线；打包机制 `kimi-code/apps/kimi-code/scripts/build-plugin-marketplace-cdn.mjs`） |
| 官方插件先例 | `kimi-code/plugins/official/kimi-datasource/`（manifest + bin + SKILL.md） |
| 本机参考实例 | `~/.kimi-code/plugins/managed/kimi-cu/`、`~/.kimi-webbridge/`、`~/.kimi-code/skills/kimi-webbridge/` |

## 10. 预装用户兼容方案（评审稿，2026-07-30）

真实用户多半已通过其他途径装过 CU / WebBridge。原则：**任何预装状态都收敛到同一个幂等动作，不破坏已有安装，显示必须诚实说出"缺什么"**。

### 10.1 途径 × 现状显示 × 处理

**kimi-cu**

| 预装途径 | 当前显示 | 处理（现实现） | 评价 |
|---|---|---|---|
| 官方全套（脚本+插件，如本机） | ready，plugin/app 各报版本 | 零操作；reinstall=升级（已实测 0.4.18→0.5.4） | ✅ 理想 |
| 其他 agent 工具途径（只装了 App+服务+权限，无 kimi-code 插件） | partial（plugin missing，其余 ok） | 货架点「安装」→ 装插件，钩子见二进制就绪 no-op → ready | ✅ 顺滑 |
| 只装了插件（无 App） | partial（app/service/permissions missing） | 钩子在插件 false→true 边沿自动补装二进制；**但历史上（钩子出现前）装的一直停在 partial，需 Phase 1 卡片给「一键修复」** | ⚠️ 存量需修复入口 |
| 插件/App 版本不一致（锁步发布被打破） | 两行版本各自显示，顶层 version 取 App | 不告警；reinstall 对齐 | ⚠️ 可加不一致提示（见决策点 D3） |
| 权限被撤销/未授 | partial，permissions missing+detail | 权限引导 + 重新检测（硬门槛） | ✅ 已覆盖 |
| 插件 disabled | partial（plugin missing）；货架行 Switch 关 | Switch 打开即可，无需重装 | ✅ 已覆盖 |

**WebBridge**

| 预装途径 | 当前显示 | 处理（现实现） | 评价 |
|---|---|---|---|
| 官方 install.sh 全套（daemon+user 源 skill+扩展） | **partial（skill missing）**——用户明明"装过且能用" | capability install：daemon 层 no-op → 装插件 → 删 user 源 skill 解遮蔽 → plugin 源接管 → ready | ⚠️ 显示要解释（见 D1/D4） |
| 只装 daemon（无 skill/扩展） | partial（skill missing，extension optional missing） | 同上；扩展保持软提示 | ✅ 顺滑 |
| guide 插件（3.0.4） | **skill ok（过渡态假象）**——id 匹配但没有使用 skill | 需求方拍板不修：`plugins/cdn` 重发后被 1.11.3 替换，reinstall 归位 | ⚠️ 接受窗口期（见 D2） |
| Kimi Work 装的 daemon | 同"官方全套"场景 | 只 start-if-down，永不 stop/restart/uninstall（已内置） | ✅ 已覆盖 |
| 扩展版本 < skill（官方失配报错场景） | extension 仅布尔，无版本 | use-time 官方报错兜底 | ⚠️ 可显示 extension_version（见 D3） |
| 多 runtime（其他 agent 工具也有 skill） | 不受影响 | 解遮蔽只删 kimi-code user 源，其他 runtime 不动 | ✅ 已覆盖 |

### 10.2 统一显示模型（Phase 1 卡片落点）

四类状态 + 一个动作：

| 状态 | 判据 | 显示 | 动作 |
|---|---|---|---|
| ready | 必需步骤全 ok | 版本号（分行：plugin vs app/daemon；webbridge 可带 extension_version） | 「重新安装/修复」（次要入口） |
| partial·缺接线 | 二进制 ok、接线 missing | 「检测到现有运行环境，接入插件即可」 | **「接入」**（=install，秒级） |
| partial·缺二进制 | 接线 ok、二进制 missing | 「插件已安装，需要安装运行环境」 | **「安装运行环境」**（=install，带下载进度） |
| partial·缺人工步骤 | 其余 ok、权限/扩展 missing | 硬门槛（权限）图文引导 + 重新检测；软门槛（扩展）提示不阻塞 | 引导按钮 |
| not_installed | 全 missing | 「安装」 | 全流程 |
| unsupported | 平台不符 | 灰显不可点 | — |

关键点：**按钮只有一个，永远幂等**——文案随状态变（接入/安装运行环境/安装），动作恒为 `install`。货架行与能力卡片是同一动作的两个视角（货架装插件视角，卡片装全套视角），货架安装经钩子同样收敛，两入口不冲突。

### 10.3 处理原则（已在实现中的，重申）

1. 幂等可重入：任何预装态点同一个按钮都收敛 ready。
2. 不破坏：upsert 保 enabled/installedAt；解遮蔽只动 kimi-code user 源；其他 runtime 不动；Kimi Work daemon 只 start。
3. 诚实显示：partial 必须说清缺什么；版本分行；过渡态在 UI hint 与文档说明。

### 10.4 决策点（已评审，2026-07-30）

- **D1**：**统一叫「安装」**——不分「接入/安装」文案，动作恒为 install。
- **D2**：**维持直接替换**，detect 不加内容检查；guide 过渡态到 `plugins/cdn` 重发为止。
- **D3**：**不做**版本行丰富化（extension_version、插件/App 对齐提示均不实现）。
- **D4**：**做且已落地**——capability install 增加机器码 note（`user-skill-migrated`）经 `CapabilityInstallProgress.note` 透出（上游 `178189554`）；webbridge 条目在迁移确实发生时返回该 note；desktop 货架安装后查询并在行内显示本地化提示（`settings.plugins.note.*`，中英双语已就位）。
