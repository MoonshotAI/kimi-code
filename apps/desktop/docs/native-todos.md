# Desktop 原生化 TODO

桌面端目前大量功能仍用 web 方式实现。preload 已暴露 16 个桥接方法（`src/main/preload.ts`），部分通道已打好未接线。本文档记录可原生化的功能清单，逐项跟踪。

改之前注意两点：

- `src/renderer/` 是 `apps/web/src` 的整份快照副本，改任何共享组件前先想清楚边界：web 版只能走 daemon REST，desktop 走原生，用 `lib/desktopFlag.ts` 的 `isDesktop` / `isMacosDesktop` 或 `window.kimiDesktop` 探测分流。
- 改共享文件后需同步回 `apps/web`（开发顺序：先在 desktop 开发，再同步 web，见根 AGENTS.md）。

## TODO

- [x] **New workspace 用原生目录选择器**（已完成，desktop 专属）
  - 实现：`src/renderer/lib/nativeWorkspacePicker.ts`（`properties: ['openDirectory', 'createDirectory']`，复用主进程早已注册的 `kimi:dialog-open`）。desktop renderer 恒在 Electron 内运行，桥恒存在，所以唯一判断是 `canPickWorkspaceDirectory()`（`window.kimiDesktop` 在不在）；`pickWorkspaceDirectory()` 无任何存在性检查，缺桥/IPC 异常统一由 try/catch 归到 `{status:'error'}`。流程逻辑在 `createAddWorkspaceEntry(deps)`（可注入依赖、带重入防护）：native 选中 → `addWorkspace`；用户取消 → 丢 pending；桥故障或 daemon 拒绝 → 报错并回退原 `AddWorkspaceDialog`；无桥 → 直接回退。`App.vue` 只做绑定，所有 add-workspace 入口统一走它。
  - **web 刻意不改**：`apps/web` 维持原 daemon 目录浏览器（用户明确决定），因此 `App.vue` 在两端从此分叉，后续整目录 re-copy 同步时需保留 desktop 侧的 `requestAddWorkspace` / `addWorkspace` 块（lib 测试已钉住四条路径，同步冲掉会亮红）。
  - 测试：`src/renderer/lib/nativeWorkspacePicker.test.ts`（15 用例：选择器原语 + 流程四条路径 + 重入）。

- [x] **外链统一走系统浏览器（体验缺口最大）**（已完成，desktop 专属）
  - 实现：新增 `src/main/external-links.ts`——`setWindowOpenHandler` 把 http(s) 的 `window.open` / `target="_blank"` 全部拒绝开窗并转 `shell.openExternal`（PR 链接、OAuth 登录、文件预览下载、Markdown 外链一次全覆盖，renderer 零改动）；`will-navigate` 拦截跨域 http(s) 导航（同源放行，dev HMR 不受影响）；`about:blank` 弹窗放行（DebugPanel 靠它挂 Vue 实例）。
  - 测试：`tests/main/external-links.test.ts`（10 用例，纯函数 + mock webContents）。
  - 遗留：`kimi:open-external` IPC 仍闲置，renderer 有显式开外链需求时可再接。

- [ ] **系统通知改主进程 Notification**
  - 现状：`composables/client/useNotification.ts` 用 Web Notification API（完成/提问/审批三类，点击 `window.focus()`）。
  - 做法：desktop 下转发给主进程 `Electron.Notification`，可支持 action 按钮、可靠聚焦。

- [ ] **聊天附件选择用原生 dialog**
  - 现状：`Composer.vue:924` 隐藏 `<input type="file" accept="image/*,video/*">`，逻辑在 `useAttachmentUpload.ts`。
  - 做法：desktop 下调 `showOpenDialog` 直接拿本地路径。

- [x] **macOS 全屏时侧栏开关贴左边**（已完成，desktop 专属）
  - 实现：hidden title bar 下常驻的 sidebar toggle 平时停在红绿灯右侧（`App.vue` `left: 72px`）；全屏后红绿灯隐藏，按钮左移贴窗口边（`left: 16px`），收起态的 chat-header 左 padding 同步从 108px 回到 52px（`.app.macos-desktop.fullscreen` 规则）。主进程 `window.ts` 向 renderer 推送 `kimi:fullscreen-changed`（enter/leave-full-screen），renderer 初值走 `kimi:is-fullscreen` invoke（preload 暴露 `isFullscreen()` / `onFullscreenChanged()`）；renderer 侧 `composables/useFullscreen.ts` 单例跟踪，无桥恒 false（无桥降级）。
  - **web 不改**：红绿灯只存在于 Electron macOS；`App.vue` 两端分叉又添一块（模板 class、fullscreen CSS、import），整目录 re-copy 时需保留。
  - 测试：`src/renderer/composables/useFullscreen.test.ts`（4 用例：无桥、初值、推送、桥故障）；`tests/main/preload.test.ts` 白名单 + 通道断言同步更新。

- [x] **打开文件 / 在 Finder 显示 / OpenIn 菜单本地化**（OpenIn 部分已完成，desktop 专属）
  - 实现：「用 xxx 打开」全链路在主进程、不走 daemon REST。`src/main/open-in.ts` 负责应用目录检测（macOS only：`/Applications` + `~/Applications` 存在性；Finder/Terminal 系统恒有）与启动（`open -a <bundle>` / Finder 裸 `open <dir>` / Terminal 用 `open -b com.apple.Terminal`，各 app 的文件夹打开能力已对 Info.plist 核实；Xcode 未声明 folder 注册，纯目录可能只弹提示——已知限制）。IPC：`kimi:open-in-list` / `kimi:open-in`（`ipc-channels.ts` + `ipc.ts`，参数在 handler 校验），preload 白名单加 `listOpenInApps` / `openInApp`（`preload.test.ts` 同步）。renderer 侧 `src/renderer/lib/nativeOpenIn.ts`：`canOpenInNative()` 探测（桥缺方法也判 false），列表/打开失败一律归 false/[]（无桥降级=隐藏入口，不回退 REST，用户明确决定）。`ChatHeader.vue` 挂载 `OpenInMenu.vue`（desktop 分叉块：import/onMounted/模板 `showOpenIn` 块，整目录 re-copy 时需保留）；`OpenInMenu.vue` 与 web 版整体分叉重写：紧凑 pill（左=当前选中应用图标，点击只打开不写盘；右=caret 展开菜单，菜单项点击才=打开+选中），菜单项带彩色图标。选中态单源：菜单点击与设置页写同一个 key `kimi-web.open-in.default-target`（`saveDefaultOpenInTarget`，模块级响应式 ref `useDefaultOpenInTarget`，改动同 tick 同步到 pill 与设置页），未选择时显示第一个可用（`resolveOpenInTarget`）。注意 pill 自带 `-webkit-app-region: no-drag`（ChatHeader 的 scoped no-drag 规则到不了子组件内部，不写会被 macOS 拖拽区吃掉点击）；菜单打开期间在 capture 阶段吞掉 Escape（ConversationPane 的 document 级 bubble 监听会把 Esc 当中断运行，capture 先执行，Esc 只关菜单）。设置项在 `SettingsDialog.vue` 通用页（desktop 分叉块，`openInAppOptions` 为 null 即隐藏），选项即检测到的应用列表。
  - 测试：`tests/main/open-in.test.ts`（13 用例：平台门控、检测、argv 构造、失败回传）；`tests/main/preload.test.ts` 白名单；`src/renderer/lib/nativeOpenIn.test.ts`（16 用例：桥探测、列表过滤、打开回传、默认目标持久化、快捷解析优先级）。
  - 遗留：打开失败暂无 UI 反馈（静默）；「打开文件 / 在 Finder 显示」（FilePreview 的 `openWorkspaceFile`/`revealWorkspaceFile`）仍走 daemon REST，未原生化。
  - 图标：彩色官方图标从本机 app bundle 的 `.icns` 提取为 128px PNG（`src/renderer/assets/app-icons/`，9 个），经 `lib/nativeOpenIn.ts` 的 `openInAppIcon(id)` 映射；菜单项与快捷按钮用 `<img>` 渲染（nominative use），设置页 Select 靠 web-ui `Select` 新增的 `option.icon` 字段（可选、向后兼容，web 同步受益）。
  - 已知限制：第一版仅 macOS；Windows/Linux 返回空目录并隐藏入口。

- [x] **文件导出走保存对话框**（已完成，desktop 专属）
  - 实现：新增 `src/main/downloads.ts`——主进程 `will-download` 统一接管所有下载（会话导出 zip、trace 日志、未来任何下载），`dialog.showSaveDialogSync` 弹系统保存框（预选"上次目录 + 建议文件名"，首次 `~/Downloads`），确认才 `setSavePath` 落盘、取消 `item.cancel()` 不落盘；`WeakSet` 防窗口重建重复注册（renderer 零改动、零 web 分叉，未走 `kimi:dialog-save` IPC）。
  - 测试：`tests/main/downloads.test.ts`（6 用例：首次目录、写入选中路径、取消不落盘、记住目录、取消不清记忆、防重复安装）。
  - 已知限制：目录记忆只存内存，重启 app 回 `~/Downloads`。

- [ ] **确认弹窗原生化**
  - 现状：自研 Promise 化确认框 `useConfirmDialog.ts` + `ConfirmDialogHost.vue`。
  - 做法：desktop 下换 `dialog.showMessageBox`。

- [ ] **应用级快捷键进原生菜单**
  - 现状：大量 web `keydown` 监听（Esc 关侧栏/中断运行、Cmd+K 搜索、Enter 发送等，散在 `App.vue` / `ConversationPane.vue` / `Sidebar.vue` / `Composer.vue`）；编辑类快捷键靠 `editMenu` role 白送，应用级命令没有原生 accelerator。
  - 做法：高频命令（新建会话、设置、搜索等）注册到 `src/main/menu.ts`，经 `kimi:menu-action` 转发 renderer（channel 已存在，renderer 未监听）。

- [ ] **最近工作区接入 OS**
  - 现状：全靠 localStorage + server `recentRoots`。
  - 做法：`app.addRecentDocument`（macOS dock 最近文档）/ Windows Jump List。

- [ ] **server token 改走 IPC**
  - 现状：`renderer/lib/serverAuth.ts` 从 URL `#token=` hash 读 token 再镜像 localStorage（7 天 TTL）。
  - 做法：`kimi:get-server-token` IPC 已存在未用，desktop 可直接问主进程要，省掉 hash 注入与 localStorage 持久化。

- [x] **系统托盘常驻图标**（已完成，desktop 专属）
  - 实现：新增 `src/main/tray.ts`——`Tray` + 单一右键/左击菜单（`显示主窗口` / `退出`）；macOS 下 status item 设了 context menu 后单击即弹菜单，Windows 左键额外接 `click → popUpContextMenu` 对齐行为。托盘图标按平台分资产（`trayIconPath` 纯函数）：macOS 用 `trayTemplate.png`/`@2x`（机器人单色剪影、眼睛镂空，`Template` 文件名让 nativeImage 自动标记为 template image，OS 按深浅色菜单栏自动反色）；Windows 用 `tray.ico`，Linux 用 `tray.png`/`tray@2x.png`（满铺白底圆角方块 + 机器人的彩色构图）；经 `electron-builder.config.cjs` `extraResources` 的 `build/` + `filter: ['tray*']` 进 resources（注意 extraResources 的 `from` **不吃 glob**，写成 `build/tray*` 会被当字面路径静默跳过——v0.0.2 就踩了这个、包里没有托盘，见 config 注释）。`index.ts` 模块级持有 `Tray` 引用（无引用会被 GC、图标消失），`before-quit` 里 `tray.destroy()`；`quit` 走 `app.quit()`，server 清理照常执行。
  - **web 无对应物**：浏览器没有托盘面，`apps/web` 不涉及（非共享文件分叉）。
  - 测试：`tests/main/tray.test.ts`（`trayIconPath` 纯函数 3 用例：win32 取 .ico、mac/linux 取 png、packaged 走 resourcesPath）。

- [x] **自动更新（electron-updater + CDN generic feed）**（已完成，desktop 专属）
  - 实现：新增 `src/main/updater.ts`——electron-updater generic provider 轮询 `https://code.kimi.com/kimi-code/desktop/` 的 latest*.yml（feed 在 `electron-builder.config.cjs` 的 `publish` 配置里）；`autoDownload=false`（用户点击才下载）、`autoInstallOnAppQuit=true`（自然退出时静默装）；启动 10s 首查、之后每 4h；状态机 idle→available→downloading→downloaded/error 经 `kimi:update-status` 推送 renderer，status 含 version/percent/releaseDate。只打扰用户该知道的：后台检查失败仅 `console.warn` 保持 idle，仅用户发起的下载失败进 error 态（可重试）；feed 回滚（`update-not-available`）时清掉未开始下载的 available / 失败待重试的 error 态，进行中的下载/安装不动。dev（未打包）整体 no-op。IPC：renderer 初值走 `kimi:update-get-status`，动作走 `kimi:update-download` / `kimi:update-install`（`quitAndInstall(true, true)`）。
  - 桥：preload 新增 `getUpdateStatus` / `onUpdateStatus` / `downloadUpdate` / `installUpdate`（payload 经 `asUpdateStatus` 结构校验，畸形丢弃）；renderer `composables/useUpdateStatus.ts` 单例（照 useFullscreen 模式），无桥恒 idle；`visible` 计算属性实现"本次跳过"（localStorage `kimi-web.update-skipped-version` 持久化，仅作用于 available 态，出现更高版本自动解除）。
  - UI：`components/UpdateIndicator.vue` 挂在 Sidebar `.ch` 的 `.ch-tail` 组里（收起按钮之右，全 header 最右端；mac 上是红绿灯拖拽条右端，`no-drag` 保点击）——黄色 pill（`--color-warning`）文案随状态变（更新 / `42%` / 下载完成 / 下载失败，下载中用纯百分比 + tabular-nums + 固定 4ch 防抖动）；窄栏 < 250px 经 `@container sidebar-col` 退化为纯图标圆点（与 brand 文字隐藏同断点）。点击开 §03 Dialog（§09 Anatomy A，padded · md · auto，已登记进 DesignSystemView 的 dialog map）：标题含版本、meta 行（发布日期 · 当前版本，`__KIMI_CLIENT_VERSION__`）、foot 右对齐三态按钮（本次跳过→下载并更新 / 下次启动→立即重启 / 重试）。**web 无桥恒不渲染**——组件、composable 与 Sidebar 改动已同步 apps/web，两端 `Sidebar.vue` 仍完全一致，无分叉。
  - 打包：artifactName 改 `KimiCode-${version}-${os}-${arch}.${ext}`（自动更新要求文件名含版本号；原 MMDD 内测命名废弃）；mac target 加 `zip`（macOS 自动更新只认 zip，dmg 仅分发）；配 `publish` 后 dist-app 产出 latest-mac.yml / latest.yml / latest-linux.yml + blockmap，已加进 desktop-build.yml 的 artifact glob，随通配进 GitHub Release；两个 mac leg 的 latest-mac.yml 按 arch 改名避让（artifact 合并下载同名会覆盖），release.yml 发布前跑 `scripts/merge-mac-update-yml.mjs` 合并回单文件（零依赖文本级合并，files 含双 arch，electron-updater 按 arch 自选 zip）。
  - CDN：布局对齐 CLI——版本目录 `desktop/<version>/`（immutable）+ 根目录 latest*.yml 指针（no-cache，`path`/`url` 改写 `<version>/` 前缀）+ `desktop/download/` 固定下载入口（官网链接，TOS 服务端复制当版本产物为恒定文件名）；发布走本仓 `scripts/publish-desktop-cdn.sh`（2026-07 从 kimi-cli-cdn-sync 仓迁入；本地手动，TOS 凭证限内网）；回滚 = 旧版本号重跑该脚本。
  - 测试：`tests/main/updater.test.ts`（7 用例：dev no-op、autoDownload 配置与定时检查、状态流、下载失败 error + 重试、后台失败静默、回滚清态、动作状态守卫）；`tests/renderer/useUpdateStatus.test.ts`（10 用例：含 skip/visibility/快照竞态）；`tests/main/preload.test.ts` 白名单 + 通道断言同步。

## 已原生化的（不用动）

- 深色模式同步：renderer → `kimi:theme` → `nativeTheme.themeSource`
- macOS 隐藏标题栏 + 红绿灯位置、CSS `-webkit-app-region: drag` 拖拽区
- 原生菜单（App/Edit/View/Window）、`Cmd+Alt+K` 全局快捷键
- 窗口尺寸/位置持久化、`app://renderer` 自定义协议、内嵌 server

## 参考

- IPC channel 定义：`src/main/ipc-channels.ts`（15 个 channel）
- preload 白名单测试：`tests/main/preload.test.ts`（新增桥接方法要同步更新）
