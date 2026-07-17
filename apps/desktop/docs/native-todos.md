# Desktop 原生化 TODO

桌面端目前大量功能仍用 web 方式实现。preload 已暴露 10 个桥接方法（`src/main/preload.ts`），部分通道已打好未接线。本文档记录可原生化的功能清单，逐项跟踪。

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

- [ ] **打开文件 / 在 Finder 显示 / OpenIn 菜单本地化**
  - 现状：`useWorkspaceState.ts:2405-2439`（`openWorkspaceFile` / `revealWorkspaceFile` / `openInApp`）走 daemon REST 由 server 执行 OS 打开；UI 入口 `FilePreview.vue:493`、`OpenInMenu.vue`。
  - 做法：desktop 里 server 同进程，可主进程直接 `shell.openPath` / `shell.showItemInFolder`，省一跳。

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
  - 实现：新增 `src/main/tray.ts`——`Tray` + 单一右键/左击菜单（`显示主窗口` / `退出`）；macOS 下 status item 设了 context menu 后单击即弹菜单，Windows 左键额外接 `click → popUpContextMenu` 对齐行为。托盘图标按平台分资产（`trayIconPath` 纯函数）：macOS 用 `trayTemplate.png`/`@2x`（机器人单色剪影、眼睛镂空，`Template` 文件名让 nativeImage 自动标记为 template image，OS 按深浅色菜单栏自动反色）；Windows 用 `tray.ico`，Linux 用 `tray.png`/`tray@2x.png`（满铺白底圆角方块 + 机器人的彩色构图）；经 `electron-builder.config.cjs` `extraResources` 的 `build/tray*` 进 resources。`index.ts` 模块级持有 `Tray` 引用（无引用会被 GC、图标消失），`before-quit` 里 `tray.destroy()`；`quit` 走 `app.quit()`，server 清理照常执行。
  - **web 无对应物**：浏览器没有托盘面，`apps/web` 不涉及（非共享文件分叉）。
  - 测试：`tests/main/tray.test.ts`（`trayIconPath` 纯函数 3 用例：win32 取 .ico、mac/linux 取 png、packaged 走 resourcesPath）。

## 已原生化的（不用动）

- 深色模式同步：renderer → `kimi:theme` → `nativeTheme.themeSource`
- macOS 隐藏标题栏 + 红绿灯位置、CSS `-webkit-app-region: drag` 拖拽区
- 原生菜单（App/Edit/View/Window）、`Cmd+Alt+K` 全局快捷键
- 窗口尺寸/位置持久化、`app://renderer` 自定义协议、内嵌 server

## 参考

- IPC channel 定义：`src/main/ipc-channels.ts`（9 个 channel）
- preload 白名单测试：`tests/main/preload.test.ts`（新增桥接方法要同步更新）
