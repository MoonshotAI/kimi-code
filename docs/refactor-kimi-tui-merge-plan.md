# KimiTUI 重构分支 — 合并 main 计划（2026-05-28）

> 分支：`refactor-kimi-tui`
> 上次合并点：`27749de`（已合并 main 至 `2c7a8cc`）
> 目标合并点：`50251a1`（main 当前 HEAD）
> 新增待合并 commits：4 个

---

## 一、分支结构差异（重构后 vs main）

| 模块 | main 结构 | refactor 结构 |
|---|---|---|
| `tui/kimi-tui.ts` | 6695 行 God-class（含全部 controller / 命令逻辑） | 1666 行薄协调器，仅做依赖编织和 host 接口 |
| `tui/controllers/` | 不存在 | 6 个 controller：`auth-flow.ts`、`editor-keyboard.ts`、`session-event-handler.ts`、`session-replay.ts`、`streaming-ui.ts`、`tasks-browser.ts` |
| `tui/commands/` | 6 个文件（`index/parse/registry/resolve/skills/types`） | 12 个文件，新增 6 个领域命令模块：`auth.ts`、`config.ts`、`dispatch.ts`、`info.ts`、`prompts.ts`、`session.ts` |
| `tui/tui-state.ts` | 顶层 mutable 字段（`yolo`、`isStreaming` 等散落） | 字段精简，可变状态收敛到对应 controller，host 提供 mutation 方法 |
| `tui/types.ts` | 含 `TUIStartupOptions`、`KimiTUIOptions`、`PendingExit`、`LoginProgressSpinnerHandle` 等启动期类型 | 已移除（迁到对应模块） |
| `tui/utils/startup.ts` | 包含 `combineStartupNotice`、`isOAuthLoginRequiredError` | 已删除（去重后内联） |

合并的核心矛盾：main 上的所有 TUI 修改都直接打在 `kimi-tui.ts` 的对应方法上，而这些方法在重构分支已被搬到 controller / command 模块。所以 cherry-pick 必然冲突，需要逐个把 patch「翻译」到新位置。

---

## 二、main 新增的 4 个 commit 与影响范围

### 2.1 `ebf6e81` feat: add plugin manager and official plugins (#119)

**功能**：插件管理器（manager + manifest + archive + store + 远端 marketplace），TUI `/plugins` 命令，官方 datasource 插件。

**改动文件量**：约 50 个文件，3500+ 行新增。

| 类别 | 文件 | 重构分支位置/动作 |
|---|---|---|
| TUI 入口 `kimi-tui.ts` | 新增 import、`/plugins` case 分发、`showPluginsPicker`、`handlePluginsCommand`、`showPluginMarketplace`、`showPluginRemoveConfirm` 等 ~10 个私有方法（共 +381 行） | **拆**：分发入口写到 `commands/dispatch.ts`（参考已有 `/mcp`、`/editor` 模式）；选择器/弹窗逻辑作为一个新 command 模块 `commands/plugins.ts`（独立成文件，避免堆回 `kimi-tui.ts`） |
| `commands/registry.ts` | 注册 `plugins` 内建 slash command（+7 行） | **直接 apply**：refactor 分支的 registry 同位置可吃 |
| `components/dialogs/plugins-selector.ts` | 新建，4 个 Component（Overview / Marketplace / Mcp / RemoveConfirm，603 行） | **直接 apply**：纯新增文件，无冲突 |
| `components/messages/plugins-status-panel.ts` | 新建，`buildPluginsInfoLines` / `buildPluginsListLines`（128 行） | **直接 apply**：纯新增 |
| `components/dialogs/choice-picker.ts` | 新增 `notice` 字段；`onSelect` 同时接受空格键 | **直接 apply**：重构分支未改动该文件 |
| `utils/plugin-marketplace.ts` | 新建（213 行） | **直接 apply** |
| `cli/commands.ts` + `cli/sub/plugin-run-node.ts` + `main.ts` | 新增隐藏命令 `__plugin_run_node`，用于插件子进程入口 | **直接 apply**：与 TUI 重构无关 |
| `constant/app.ts` | 新增 `KIMI_CODE_PLUGIN_MARKETPLACE_URL*` 常量 | **直接 apply** |
| `package.json` + `scripts/dev*.mjs` | `dev` 改用 `scripts/dev.mjs`（并跑 marketplace server）；新增 build/dev marketplace 脚本 | **直接 apply** |
| `packages/agent-core/src/plugin/**` | manager / manifest / archive / store / source / types（约 1200 行） | **直接 apply**：纯新增 |
| `packages/agent-core/src/agent/injection/plugin-session-start.ts` | 新建，session 启动时注入 plugin info | **直接 apply** |
| `packages/agent-core/src/rpc/core-api.ts` + `core-impl.ts` | 暴露 plugin RPC | **直接 apply** |
| `packages/agent-core/src/skill/{registry,scanner,types}.ts` | skill scanner 支持 plugin 源 | **直接 apply** |
| `packages/agent-core/src/agent/{index,tool/index}.ts` + `errors/codes.ts` | plugin capability 注入接线 | **直接 apply** |
| `packages/node-sdk/src/{rpc,session,types}.ts` | listPlugins / 等 SDK 方法（+88 行） | **直接 apply**：refactor 分支的 `kimi-tui` 通过 `this.requireSession().listPlugins()` 拉数据，依赖此 SDK |
| `plugins/official/kimi-datasource/**` + `plugins/marketplace.json` | 官方插件源码与索引 | **直接 apply** |
| 测试：`test/plugin/**`、`test/utils/plugin-marketplace.test.ts`、`test/tui/components/dialogs/plugins-selector.test.ts`、`test/tui/kimi-tui-message-flow.test.ts`（+290 行） | | message-flow 测试可能要按新 host 拆分调整；其余直接 apply |
| 文档：`docs/{en,zh}/customization/plugins.md` + `docs/.vitepress/config.ts` 等 | | **直接 apply** |

**关键迁移工作（不能机械 cherry-pick 的部分）**：
1. `kimi-tui.ts` 中的 `/plugins` 分发：refactor 已经把 dispatch 表交给 `commands/dispatch.ts`，必须接入到那里。
2. 10 个 `showPlugins*` / `handlePlugins*` 私有方法：建议**新建 `commands/plugins.ts`**，按照 `commands/auth.ts`、`commands/info.ts` 同款签名（接受 host 接口、返回 Promise<void>），并通过 host 暴露 `mountEditorReplacement` / `restoreEditor` / `requireSession` / `showError` 等已有方法。
3. host 接口（在 `kimi-tui.ts` 中的 `private buildCommandsHost()` 之类位置）需要补充供 plugins.ts 使用的方法（如果还没有）。

---

### 2.2 `50251a1` fix(approval): show file content/diff and open full-screen preview on ctrl+e (#139)

**功能**：
- approval-panel 显示 file IO 的内容 / diff；
- ctrl+e 切换为全屏 `ApprovalPreviewViewer`（不再就地展开）。

**改动文件量**：7 个文件，~700 行。

| 类别 | 文件 | 重构分支位置/动作 |
|---|---|---|
| `components/dialogs/approval-preview.ts` | 新建（250 行），独立 Viewer 组件 | **直接 apply**：纯新增 |
| `components/dialogs/approval-panel.ts` | 移除内部 `expanded` toggle；`onExpand` 回调签名增加 `block` 参数 | **直接 apply**：refactor 分支未触碰该组件 |
| `reverse-rpc/approval/adapter.ts` | `file_io` display 提升 content/before/after 为 `file_content` / `diff` block | **直接 apply**：refactor 分支未触碰 |
| `kimi-tui.ts` — `activeApprovalPanel`、`approvalPreview` 两个新字段；`showApprovalPanel` 多传一个 `onPreview` 回调；新增 `openApprovalPreview` / `closeApprovalPreview`；`hideApprovalPanel` 先收起 preview（+63 行） | **手工迁移**：refactor 分支的 `showApprovalPanel` / `hideApprovalPanel` 仍在 `kimi-tui.ts:1611-1636`，**位置正确**，可以原样补 patch；只需注意：<br>① 两个新私有字段；<br>② `state.ui.children` / `state.ui.clear` / `state.ui.addChild` / `state.ui.setFocus` / `state.ui.requestRender` 调用必须走 host 方法（按本分支「TUIState mutation 走 host」的约束，参见 commit `69953f5`）—— 检查这些方法是否已存在，缺则补 host 方法。 |
| 测试：`test/tui/components/dialogs/approval-panel.test.ts`（覆盖更新）+ `approval-preview.test.ts`（新建）+ `test/tui/reverse-rpc/approval-adapter.test.ts`（新建） | | **直接 apply** |

---

### 2.3 `16e881e` docs(changelog): sync 0.4.0 from apps/kimi-code/CHANGELOG.md (#125)

只动 `docs/{en,zh}/release-notes/changelog.md`。**直接 apply**，无冲突。

### 2.4 `fa114c1` ci: release packages (#93)

changeset 自动 release：删除 13 个 `.changeset/*.md`、更新各 package 的 `CHANGELOG.md` / `package.json` 版本号。
- **直接 apply**：均在 `packages/*` 和 `apps/kimi-code` 根目录，与 TUI 重构无关。
- ⚠️ 注意：refactor 分支自分叉以来不应有自己新增的 changeset（确认下；如有，要保留）。

---

## 三、合并策略推荐

**方案 A — 单个 merge commit（推荐）**

```
git checkout refactor-kimi-tui
git merge main
# 解决 kimi-tui.ts 等冲突，按上文规则把 plugin / approval-preview patch 翻译到新位置
git merge --continue
```

理由：本分支已用过这个方式合并 12 个 commit（`27749de`），团队习惯一致；4 个 commit 一次性解决，避免反复打开同一文件。

**方案 B — 拆成 2 个 merge 阶段**

适合需要把 plugin 大改动单独 review 的场景：

1. 先合 `ebf6e81`（plugin 主体），单独提 PR；
2. 再合剩余 3 个 commit。

不推荐，理由：CHANGELOG/版本号 commit 与 plugin commit 互相引用，拆开反而要解二次冲突。

---

## 四、冲突点逐文件清单

合并执行后，预计 `git status` 中的 UU 文件：

| 文件 | 冲突原因 | 处理 |
|---|---|---|
| `apps/kimi-code/src/tui/kimi-tui.ts` | plugin 入口 +381 行、approval-preview +63 行；refactor 分支结构已变 | 手工迁移（见 §2.1、§2.2） |
| `apps/kimi-code/src/tui/commands/registry.ts` | 同位置新增 `plugins` 条目 | 简单 take both |
| `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts` | main 新增 290 行 plugin 相关测试；refactor 重写过 host fixture | 逐 case 迁移，对齐新 host 形态 |

预计**纯新增、零冲突**的文件：约 45 个（plugin 子系统、approval-preview、docs、changelog、官方插件）。

---

## 五、执行检查清单

- [ ] `git merge main` 并解决上述 3 处冲突
- [ ] 新建 `apps/kimi-code/src/tui/commands/plugins.ts`，把 plugin UI 方法搬过去
- [ ] 在 `kimi-tui.ts` 的 host 接口里补 `mountEditorReplacement`/`restoreEditor`/... 暴露给 plugins.ts（如缺）
- [ ] 把 approval-preview 的两个新字段和两个新方法补回 `kimi-tui.ts`，确认 `state.ui` mutation 已走 host 方法（commit `69953f5` 的约束）
- [ ] `pnpm -F kimi-code typecheck`
- [ ] `pnpm -F kimi-code test`
- [ ] `pnpm -F agent-core test`（plugin 子系统的 4 个 test 套件）
- [ ] 手动验：`/plugins` 打开，浏览 marketplace、安装、卸载
- [ ] 手动验：approval-panel 上 Write / Edit 显示内容/diff，ctrl+e 打开全屏 viewer，ESC 返回保留选中态
- [ ] 检查 refactor 分支是否有自己的 changeset，若有保留
- [ ] lint / format / test 变动文件
