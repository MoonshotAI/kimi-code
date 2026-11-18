# 诊断日志与导出

桌面端的诊断数据落在固定目录 `<KIMI_CODE_HOME>/logs/`（默认 `~/.kimi-code/logs/`，Windows 为 `%USERPROFILE%\.kimi-code\logs\`）。用户反馈白屏、崩溃、卡死时，优先请用户用「帮助 → 导出诊断信息…」或托盘菜单的同名入口导出；导出失败时，让用户把失败弹窗或启动失败页列出的目录压缩发来。

`KIMI_CODE_HOME` 只写在 shell 配置里、应用从 Finder / Dock / 桌面图标启动时（macOS、Linux），启动阶段用的是默认 home：崩溃收集器的目录在此时固定下来，主日志则在 shell 环境导入后切到新 home。这时诊断数据分布在两个 `logs` 目录，导出、过期清理、失败弹窗和启动失败页都会覆盖这两个目录。

## 文件

| 路径 | 内容 | 保留 |
|---|---|---|
| `kimi-code-desktop.log` | 主日志：主进程、渲染进程（经 IPC 转发）、内嵌 server 的 warn 及以上 | 超过 5MB 轮转 |
| `kimi-code-desktop.log.1` … `.5` | 轮转历史，`.1` 最新 | 30 天，最多 5 个 |
| `kimi-code.log*` | agent-core 全局日志（由核心仓维护，只随诊断包导出） | 由核心仓管理 |
| `desktop-incidents/*.json` | 白屏看门狗写下的现场快照，见下文 | 30 天，最多 20 个 |
| `desktop-crashes/<渠道>/` | Crashpad 本地 minidump，不上传；渠道为 `stable` / `canary` / `preview` / `dev` | 30 天，最多 10 个，合计 ≤ 50MB |
| `desktop-launch-<渠道>.json` | 本次启动的状态：启动 ID、版本、最后到达的启动阶段、是否正常退出、渲染进程是否死过、主进程是否抛过未处理异常；每个启动阶段和每 5 分钟刷新一次。确认退出后阶段记为 `quitting`；主动退出与 Windows 关机 / 重启 / 注销都算正常退出 | 每个渠道一个，不清理 |

各渠道共用主日志，靠行内进程标记区分；崩溃转储按渠道分目录。清理在启动 1 分钟后执行一次，之后每 24 小时一次，只删除上表中的文件，当前正在写的主日志不按时间删除。主日志路径与文件名不可改动：核心仓的会话导出按该路径收集桌面日志。

## 行格式

```
2026-10-29T02:10:13.004Z INFO  [m4821] [startup] server-ready at=+4100ms took=1790ms
```

时间（UTC）、级别、来源进程、分类标签、内容。来源 `m<pid>` 为主进程，`r<pid>` 为发出该行的渲染进程，渲染进程崩溃重启后 pid 会变。同一行在 60 秒内连续重复时只写一次，随后补一行 `previous line repeated N more times`。`[launch]` 行里的 `launch=` 与埋点通用属性 `launch_id` 相同，可以拿用户的日志对上同一次启动的埋点。

| 标签 | 含义 |
|---|---|
| `[launch]` | 每次启动的版本、渠道、启动 ID、系统、CPU、内存、日志位置 |
| `[env]` / `[gpu]` | ready 后的语言、主题、毛玻璃、硬件加速、显示器、GPU 功能状态与设备 |
| `[startup]` | 启动里程碑：主进程的 `app-ready`、`window-created`、`shell-env-ready`、`server-start`、`server-ready`、`load-url`、`load-url-done`、`connect-failed`、`web-assets-wait`；渲染进程的 `ui-mounted`（界面挂载）、`boot-<阶段>`（`auth` / `server` / `config` / `sessions` / `session`）、`ui-ready`（启动流程完成）。`at=` 为距进程启动的毫秒数。启动时如果发现上次启动没有正常退出，会记一行 `previous launch <启动 ID> ended abnormally`，带上上次最后到达的阶段 |
| `[nav]` | 主窗口导航开始、完成（含渲染进程 pid）、主框架加载失败（错误码） |
| `[preload]` | preload 脚本抛错 |
| `[proc]` | 主窗口渲染进程无响应 / 恢复 / 退出，其他子进程（GPU、网络服务等）异常退出 |
| `[console]` | 主窗口从导航开始到加载完成后 15 秒内的 error 级控制台消息（每个文档最多 30 条），覆盖主脚本执行阶段的异常和资源加载失败 |
| `[asset]` | `app://` 渲染资源返回 4xx（安装不完整、文件被隔离等），每个路径记一次 |
| `[renderer]` | 渲染进程主动上报的日志 |
| `[server]` | 内嵌 server 的 warn / error |
| `[health]` | 启动 1 分钟后起每 10 分钟一次的内存快照：主进程、界面渲染进程及其 JS 堆、全部渲染进程、GPU 进程、系统空闲内存 |
| `[power]` / `[display]` | 睡眠、唤醒、锁屏、解锁、Windows 关机 / 重启 / 注销（`session-end`，带原因），显示器增减与分辨率 / 缩放变化 |
| `[white-screen]` | 白屏看门狗命中，附现场快照文件名；启动卡住后又恢复时补记 `startup-stalled resolved` |
| `[crash]` / `[retention]` / `[diag]` | 崩溃收集器状态、过期文件清理、诊断包导出 |

主进程未处理异常的行带 `fingerprint=`，与埋点 `app_crashed` 的 `fingerprint` 相同。正式版主窗口创建之后的未处理异常只记日志和埋点，不弹窗；主窗口创建之前的仍弹错误对话框；Canary、Preview 与开发版在主窗口上弹提示：提示打开期间主进程和内嵌 server 照常运行，但提示是窗口模态的，关闭前不能操作主窗口。每次启动最多提示一次。

URL 一律去掉查询串和 hash（其中有服务地址与 token），`data:` 页面只记占位；渲染进程转发的日志和 server 日志会脱敏敏感字段并限流。

## 白屏看门狗

主窗口上的看门狗在下列情况写一份现场快照，并上报埋点 `white_screen_suspected`。每类每次启动最多两份。

| 类型 | 条件 | 额外内容 |
|---|---|---|
| `startup-stalled` | 窗口创建 10 秒后仍没有加载完界面页面；显示启动失败页或更新等待页时暂停，继续启动或重试连接后重新计 10 秒 | 页面结构探测、截图统计 |
| `not-mounted` | 界面页面加载完 10 秒仍未挂载 | 页面结构探测、截图统计 |
| `boot-stalled` | 界面挂载后 60 秒启动流程仍未完成 | 页面结构探测、截图统计 |
| `renderer-gone` | 渲染进程异常退出，5 秒后应用仍未进入退出流程 | 退出原因、退出码 |
| `unresponsive` | 渲染进程无响应 | 每秒采一次 JavaScript 调用栈，最多 8 次，按出现次数合并；是否恢复（渲染进程重新响应才算）、采样期间渲染进程是否退出 |

快照内容：类型与摘要、启动 ID、版本与渠道、运行时长、本次启动的里程碑时间线、GPU 功能状态、各进程资源、上述额外内容，以及最近 200 行日志，单个不超过 512KB。调用栈只有打包版能采到：`app://` 页面通过 `Document-Policy` 响应头授权，开发模式的页面没有这个响应头。

## 启动页与失败页

主窗口创建后立即显示启动页，页面上的步骤文字跟随启动阶段：`window-created` / `shell-env-ready` 为「正在准备运行环境」，`server-start` 为「正在启动本地服务」，`server-ready` / `load-url` 为「正在加载界面」；界面页面加载完成后由界面替换。窗口创建 10 秒后（与 `startup-stalled` 同一阈值）仍在启动页时，出现「导出诊断信息」「打开日志文件夹」「重启应用」按钮。启动失败页和更新超时页提供「重试连接」「导出诊断信息」「打开日志文件夹」「重启应用」按钮，Windows 上不依赖菜单。点「重试连接」后先回到启动页再重新连接，重试结束前再次点击不会重复连接。

这些页面与窗口底色按应用当前主题绘制，颜色与界面背景一致。应用里选择的主题记在 `ui-state.json` 的 `colorScheme`，下次启动在创建窗口前生效，启动页、底色与界面的深浅一致。

## 诊断包

导出到「下载」目录，文件名 `kimi-code-diagnostics-<本地时间>.zip`：

- `logs/`：主日志及轮转、agent-core 全局日志、各渠道的启动状态文件
- `incidents/`：现场快照
- `crashes/<渠道>/`：30 天内的 minidump
- `diagnostics.json`：导出时现场采集的版本与渠道、系统、完整 GPU 信息与功能状态、显示器、主题与毛玻璃设置、各进程 CPU / 内存、主窗口状态（可见性、URL、是否加载中 / 崩溃、渲染进程 pid、缩放）、页面结构探测和截图统计

页面结构探测只取结构不取文本：文档状态、`#app` 子节点数、是否停在启动加载页、9 个采样点命中的元素、首次内容绘制时间、加载失败的资源路径、preload 桥是否存在、视口尺寸。截图统计只保留主色和占比，不保存图片。

## 按日志定位白屏

先看有没有 `[white-screen]` 行，有的话直接打开对应的现场快照。否则以出事前最后一行 `[launch]` 为起点：

- 没有 `server-ready`：卡在 shell 环境探测或内嵌 server 启动，看 `shell-env-ready` 的 `waited=` 与 `[server]` 行
- 有 `load-url` 没有 `[nav] finish`：页面加载失败或卡住，看 `[nav] fail` 的错误码与 `[asset]`
- 有 `[nav] finish` 但没有 `ui-mounted`：preload 或主脚本执行失败，看 `[preload]` 与 `[console]`
- 有 `ui-mounted` 没有 `ui-ready`：启动流程卡在最后一个 `boot-<阶段>`，看同时段的 `[renderer]` 与 `[server]` 行
- 有 `[proc] renderer gone`：渲染进程崩溃，对照 `desktop-crashes/` 中同时间的 minidump 和之前的 `[health]`
- 有 `[proc] renderer unresponsive`：渲染进程卡死，看 `unresponsive` 快照里的调用栈
- 用户截图停在启动页：页面上的步骤文字对应最后到达的 `[startup]` 阶段，按上面几条继续看
- 用户说的是上一次启动：看本次启动开头的 `previous launch … ended abnormally` 与上次最后到达的阶段；阶段为 `quitting` 说明是退出途中被结束（如更新安装时被安装器结束、退出卡住被强杀），不是使用中崩溃
- 以上都没有：结合诊断包里的页面结构探测（界面是否已挂载、是否停在加载页）和截图统计（页面内容正常但画面单色，多为 GPU 或合成问题）

## 相关埋点

- 所有桌面端事件带通用属性 `launch_id` 与发布渠道 `release_channel`（`stable` / `canary` / `preview` / `dev`），不与事件自带的 `channel` 字段混用
- `startup_timing` 新增阶段 `ui_mounted`、`ui_ready`
- `white_screen_suspected`：`kind`、最后到达的阶段 `stage`、`elapsed_ms`
- `previous_launch_abnormal`：上次最后到达的阶段（`quitting` 为退出途中被结束）、运行时长、是否换过版本、渲染进程是否死过、主进程是否抛过未处理异常、上次的启动 ID
- `app_crashed`（主进程）与 `renderer_error` 带报错指纹 `fingerprint` 和栈顶位置 `top_frame`（打包文件名:行:列）；`renderer_error` 另带 `source`（`window` / `rejection` / `vue`）与 `phase`（`boot` 为界面可用之前，`running` 为之后）。指纹由报错类名、去掉路径 / URL / ID / 数字后的消息模板和栈顶位置计算，不上传报错原文；`ResizeObserver` 循环通知这类无害报错不再上报
- `renderer_crashed` 与 GPU 的 `app_crashed` 在进程退出 5 秒后才上报，期间应用进入退出流程则不报，关机、注销、更新重启时被结束的子进程不再计为崩溃
