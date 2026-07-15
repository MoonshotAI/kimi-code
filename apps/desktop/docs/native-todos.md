# Desktop 原生化 TODO

桌面端目前大量功能仍用 web 方式实现。preload 已暴露 8 个桥接方法（`src/main/preload.ts`），renderer 实际只用了 `setTheme` 一个，其余通道已打好未接线。本文档记录可原生化的功能清单，逐项跟踪。

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

- [ ] **打开文件 / 在 Finder 显示 / OpenIn 菜单本地化**
  - 现状：`useWorkspaceState.ts:2405-2439`（`openWorkspaceFile` / `revealWorkspaceFile` / `openInApp`）走 daemon REST 由 server 执行 OS 打开；UI 入口 `FilePreview.vue:493`、`OpenInMenu.vue`。
  - 做法：desktop 里 server 同进程，可主进程直接 `shell.openPath` / `shell.showItemInFolder`，省一跳。

- [ ] **文件导出走保存对话框**
  - 现状：会话导出（`useWorkspaceState.ts:2159`）、调试日志导出（`debug/trace.ts:608`）是 blob + `<a download>` 静默落盘。
  - 做法：desktop 下用已暴露的 `kimi:dialog-save` 让用户选路径。

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

## 已原生化的（不用动）

- 深色模式同步：renderer → `kimi:theme` → `nativeTheme.themeSource`
- macOS 隐藏标题栏 + 红绿灯位置、CSS `-webkit-app-region: drag` 拖拽区
- 原生菜单（App/Edit/View/Window）、`Cmd+Alt+K` 全局快捷键
- 窗口尺寸/位置持久化、`app://renderer` 自定义协议、内嵌 server

## 参考

- IPC channel 定义：`src/main/ipc-channels.ts`（7 个 channel）
- preload 白名单测试：`tests/main/preload.test.ts`（新增桥接方法要同步更新）
