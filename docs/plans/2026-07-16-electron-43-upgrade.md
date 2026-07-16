# Electron 33 → 43 升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/desktop` 的 Electron 从 33.4.11 升级到最新稳定版 43.1.1（electron-builder 连带升 26.x），全仓测试/类型/lint 三绿，dev 与打包冒烟通过。

**Architecture:** 纯依赖升级，预期**零源码改动**。已逐条核对官方 breaking changes（34→43）对照 desktop 实际 API 面（`protocol.handle` / `BrowserWindow` / `dialog` / `Menu` / `globalShortcut` / `ipcMain` / `nativeTheme` / `contextBridge` / `will-download` / `setWindowOpenHandler`），无直接命中；风险集中在工具链（node-pty 原生模块重建、electron-builder 26 兼容）而非代码。已验证 Electron 43 的 npm 包 `index.js` 缺二进制时会同步自下载，`scripts/dev.mjs` 的 `import electron from 'electron'` + `spawn` 路径不需要改。

**Tech Stack:** Electron 43.1.1（Chromium 150 / Node 24.17 / V8 15）、electron-builder 26.15.3（npm `latest`）、@electron/rebuild 3.7.1（fallback 4.2.0）、node-pty 1.1.0、pnpm 10.33 workspace、vitest 4、oxlint、tsdown。

**关键事实（调研结论，执行时不必重查）：**
- 栈变化：Chromium 130→150，Node 20.18→24.17，V8 13→15。ABI 跨多个大版本，`node-pty` 必须由 postinstall 的 `electron-rebuild` 重新编译。
- Electron 42+ 的 npm 包**不再有 postinstall**，二进制首次运行时按需下载（`index.js` 自愈）；`ELECTRON_SKIP_BINARY_DOWNLOAD` 失效（我们没用）。
- `pnpm-workspace.yaml:23-25` 的 `onlyBuiltDependencies: [electron]` 因此变为空转，收尾时删除。
- macOS 通知 42+ 走 UNNotification API：**未签名 app 通知静默失败**。CI 签名包不受影响；本地 dev / 未签名包通知不弹是预期行为，不是 bug。
- dialog 43+ 不传 `defaultPath` 时初始目录固定为 ~/Downloads（OS 不再记忆上次目录）。`downloads.ts:35` 显式传了 `defaultPath`，不受影响；`ipc.ts` 透传 renderer opts，最坏情况只是初始目录变 Downloads，可接受。
- 最低系统版本抬到 macOS 12+（38.0 移除 macOS 11）；Linux 默认 Wayland（38.0）、GNOME 下 GTK 4 默认（36.0）。
- desktop 主进程测试（`tests/main/`）全部走依赖注入，不 import `electron`，升级预期不影响测试。
- electron-builder 26 自身要求 Node ≥20（我们 Node 24 ✓）；asar 打包迁移到官方 `electron/asar`；隐式 publish 默认关闭（我们不 publish）。

## Global Constraints

- 仓根 `W=/Users/moonshot/Desktop/moonshot/code-app`；Node `>=24.15.0` / pnpm `10.33.0` / `engine-strict=true`。
- **不改 `kimi-code/` submodule 任何内容**；依赖方向 `code-app → kimi-code` 单向。
- Conventional Commits；**禁止** co-author；代码/注释/commit/文档**不得出现** agent / AI 工具名称；PR 描述用英文。
- **stage 用显式路径，禁止 `git add -A` / `git add .`**（仓内有构建产物目录，历史上误扫进过 commit）。
- 最小改动：能只动 `package.json` 就不动源码；不为「将来可能」加兼容代码。
- 升级相关的验证命令固定：
  - desktop 测试：`pnpm -C "$W" --filter @moonshot-ai/kimi-desktop run test`
  - 根测试：`pnpm -C "$W" test`
  - typecheck：`pnpm -C "$W" run typecheck`
  - lint：`pnpm -C "$W" run lint`
  - desktop 构建：`pnpm -C "$W" --filter @moonshot-ai/kimi-desktop run build`

**回滚预案：** 任意步骤失败无法修复时，`git checkout -- apps/desktop/package.json pnpm-lock.yaml pnpm-workspace.yaml && pnpm install` 即回到 33.4.11（postinstall 会把 node-pty 重编回旧 ABI）。

---

### Task 1: 依赖版本升级 + install 验证

**Files:**
- Modify: `apps/desktop/package.json:47-52`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `node_modules` 中 electron 43.1.1 + electron-builder 26.15.3；node-pty 已按 Electron 43 ABI 重编（供 Task 3 冒烟验证）

- [ ] **Step 1: 改 `apps/desktop/package.json` 两个版本号**

devDependencies 区块内：

```diff
     "@moonshot-ai/vite-preset": "workspace:*",
     "@vitejs/plugin-vue": "^5.2.4",
-    "electron": "33.4.11",
-    "electron-builder": "25.1.8",
+    "electron": "43.1.1",
+    "electron-builder": "26.15.3",
     "tsdown": "0.22.0",
```

（`@electron/rebuild` 本步不动，见 Step 4 的 fallback。）

- [ ] **Step 2: `pnpm install`**

Run: `pnpm -C "$W" install`
Expected: 成功退出；日志中 `@moonshot-ai/kimi-desktop` 的 postinstall（`electron-rebuild`）执行且无 `Error`/`gyp ERR!`。electron 43 无 postinstall，install 阶段**不会**下载 Electron 二进制（属预期）。

- [ ] **Step 3: 验证版本与 node-pty 重编产物**

Run: `pnpm -C "$W" --filter @moonshot-ai/kimi-desktop exec node -p "require('electron/package.json').version"`
Expected 输出: `43.1.1`

Run: `ls -la "$W/apps/desktop/node_modules/node-pty/build/Release/pty.node"`
Expected: 文件存在，mtime 为本次 install 时间（证明被重编过）。注意：`pty.node` 此刻无法用系统 Node 加载（ABI 不匹配属正常），真实加载验证在 Task 3。

- [ ] **Step 4（仅 Step 2 electron-rebuild 失败时执行）: 升级 @electron/rebuild**

把 `apps/desktop/package.json` 中 `"@electron/rebuild": "3.7.1"` 改为 `"4.2.0"`，重跑 `pnpm -C "$W" install`，重验 Step 3。若 3.7.1 本身正常则**跳过**本步（最小改动）。

- [ ] **Step 5: 触发 Electron 二进制按需下载（一次性）**

Run: `pnpm -C "$W" --filter @moonshot-ai/kimi-desktop exec electron --version`
Expected: 首次输出 `Downloading Electron binary...`（约 100MB，一次性），随后输出 `v43.1.1`。

### Task 2: 静态检查三绿 + 提交

**Files:**
- Modify: `apps/desktop/src/main/*.ts`（**仅当** Electron 43 类型变更导致 typecheck 报错时才动，预期不动）

**Interfaces:**
- Consumes: Task 1 的 node_modules 状态
- Produces: 一个可回滚的升级 commit；后续任务基于该状态做运行态验证

- [ ] **Step 1: desktop 构建（tsdown 主进程 + renderer）**

Run: `pnpm -C "$W" --filter @moonshot-ai/kimi-desktop run build`
Expected: 成功，`out/main.cjs` / `out/preload.cjs` / `desktop-dist/` 产出。

- [ ] **Step 2: 根测试**

Run: `pnpm -C "$W" test`
Expected: PASS（desktop `tests/main/` 全部 DI 不 import electron，预期零改动通过）。

- [ ] **Step 3: typecheck**

Run: `pnpm -C "$W" run typecheck`
Expected: PASS。若因 Electron 43 `.d.ts` 变更报错（最可能的位置：`src/main/ipc.ts` 的 dialog options、`src/main/protocol.ts`、`src/main/downloads.ts`），按报错行做最小修复后重跑至 PASS。

- [ ] **Step 4: lint**

Run: `pnpm -C "$W" run lint`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd "$W"
git add apps/desktop/package.json pnpm-lock.yaml   # 若 Step 3 有修复，逐个追加显式路径
git commit -m "chore(desktop): upgrade electron to 43.1.1 and electron-builder to 26.15.3"
```

### Task 3: dev 冒烟（GUI 手动检查）

**Files:**
- 无文件改动（运行态验证）；发现问题才回到 Task 2 修复并补 commit

**Interfaces:**
- Consumes: Task 1 重编的 node-pty、Task 2 的构建产物
- Produces: 冒烟结论（每项 PASS/FAIL 记录）

- [ ] **Step 1: 启动 dev**

Run: `pnpm -C "$W" run dev:desktop`
Expected: Vite dev server 起来（`http://127.0.0.1:5174` 或顺延端口），Electron 窗口打开。

- [ ] **Step 2: 逐项检查清单**

- [ ] 窗口标题「Kimi Code」，macOS traffic lights 位于 x16 y18（侧栏头部中线），全屏往返后不丢位置
- [ ] 内嵌 server 启动成功，会话列表加载出来（证明 kap-server 在 Electron 43 runtime 正常）
- [ ] 新建会话发一条消息，agent 正常流式响应
- [ ] 触发一次 bash/终端类工具调用并成功返回（**node-pty 真实加载验证**，Task 1 Step 3 的收尾证据）
- [ ] 导出 session zip：保存对话框弹出，默认目录为上次使用的目录（`defaultPath` 显式传值，43.0 默认目录变化不影响）
- [ ] AddWorkspace 原生目录选择器正常（`window.kimiDesktop` 桥路径）
- [ ] 设置里切主题 light/dark/system，窗口外观同步（nativeTheme 链路）
- [ ] 点一个外部 http 链接 → 系统浏览器打开而非新 Electron 窗口（setWindowOpenHandler）
- [ ] Ctrl+C 退出 dev，无残留进程/异常报错
- [ ] 已知预期：macOS dev（未签名）通知不弹——42.0 UNNotification 行为变化，**不是 bug**，不用修

- [ ] **Step 3: 记录结论**

任一项 FAIL：定位修复（回到 Task 2 流程），修复单独 commit 并复测该项。

### Task 4: 打包验证

**Files:**
- Modify: `apps/desktop/electron-builder.config.cjs`（**仅当** electron-builder 26 报 schema 错误时才动，预期不动）

**Interfaces:**
- Consumes: Task 2 的构建产物、Task 3 的冒烟结论
- Produces: 未签名 `.app` 打包成功证据；（可选）签名 arm64 包

- [ ] **Step 1: 未签名目录打包（快速验证 electron-builder 26 + 配置兼容）**

Run: `pnpm -C "$W" --filter @moonshot-ai/kimi-desktop exec electron-builder --config electron-builder.config.cjs --dir`
Expected: 成功产出 `apps/desktop/dist-app/mac-arm64/Kimi Code.app`；无配置 schema 报错；node-pty 被 asarUnpack 拷入（`dist-app/mac-arm64/Kimi Code.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/` 存在）。若报配置错误，按错误信息最小改 `electron-builder.config.cjs` 后重跑。

- [ ] **Step 2: 启动打包产物**

Run: `open "$W/apps/desktop/dist-app/mac-arm64/Kimi Code.app"`
Expected: 应用启动，内嵌 server 正常（会话可建、终端可用——证明 asar/asarUnpack 下 node-pty 可 dlopen）。

- [ ] **Step 3（有签名凭证时执行，否则跳过并注明）: 完整签名包**

Run: `pnpm -C "$W" run package:macos`
Expected: 走 `apps/desktop/scripts/package-local-macos.sh`，签名 + dmg/zip 产出成功（凭证要求见 `apps/desktop/README.md`）。无凭证则跳过，留给合并后的 CI 手动 job（macOS arm64/x64、Windows、Linux 四个）验证。

### Task 5: 文档与收尾

**Files:**
- Modify: `pnpm-workspace.yaml:23-25`
- Create: `docs/plans/2026-07-16-electron-43-upgrade.md`（本文件，已在）

**Interfaces:**
- Consumes: Task 1-4 全部结论
- Produces: 最终收尾 commit；仓内无过期注释

- [ ] **Step 1: 删除空转的 onlyBuiltDependencies**

`pnpm-workspace.yaml` 末尾删除（electron 42+ 已无 postinstall，该配置空转且注释已过期）：

```yaml
# Allow Electron's postinstall to extract its prebuilt binary (apps/desktop).
onlyBuiltDependencies:
  - electron
```

删除后重跑 `pnpm -C "$W" install` 确认无警告、lockfile 无意外变动。

- [ ] **Step 2: 过期引用排查**

Run: `grep -rn "Electron 33\|electron 33\|33\.4" "$W/apps/desktop" "$W/README.md" "$W/AGENTS.md" "$W/apps/desktop/README.md" "$W/apps/desktop/docs" 2>/dev/null`
Expected: 仅剩 `src/main/window.ts:126` 的「observed on Electron 33」历史注释（记录 workaround 由来，**保留不改**）。若 `native-todos.md` 或其他文件有版本相关陈述，同步更新。

- [ ] **Step 3: 提交收尾**

```bash
cd "$W"
git add pnpm-workspace.yaml docs/plans/2026-07-16-electron-43-upgrade.md
git commit -m "chore: drop obsolete electron postinstall allowance and add electron 43 upgrade plan"
```

- [ ] **Step 4: 向用户汇报升级完成状态 + 遗留项（CI 四平台手动 job 建议触发顺序：macOS arm64 → Windows → Linux）**
