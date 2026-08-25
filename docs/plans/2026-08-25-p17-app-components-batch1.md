# P17 实施：packages/app-components 第一批下沉

> 主计划：`docs/plans/renderer-refactor-plan.md` §4 P17。本文档是 P17 的执行细化，数据均为 2026-08-25（P13 合并后 main `a604adab`）当日复测。

## 1. 目标

新建 `@moonshot-ai/app-components` 共享包，把两端逐字节一致（或只差可消除的注释/埋点分叉）的组件与支撑模块单源化，两端 import 改指包。纯机械搬运，**零逻辑改动**。

完成后组件线解锁：P18（telemetry 缝）→ P19（Composer）→ P20（OpenInMenu）→ P21（Sidebar）。

## 2. 当日复测清单

`components/` 下同名 .vue 对比（desktop `src/renderer/components/` vs web `src/components/`）：

- **字节一致 75 个**（P13 清理 provenance 注释后从 73 涨到 75，新增 PlanTool、SecondaryModelPicker 进入一致集，AgentDetailPanel 已收敛）——全量下沉。
- **可解锁 3 个**：`SessionRow.vue`（17 行 diff = desktop-only track 埋点块）、`chat/ThinkingBlock.vue`（4 行 diff = 同上）、`chat/SelectionActionBubble.vue`（2 行 diff = 首行注释措辞）。前两个按 P6/P18 既定模式把 `track` 改走注入缝后 diff 归零，第三个注释中立化——三者随本批下沉。
- 真实分叉 28 个：不动。其中 ChatHeader / ApprovalCard / UserMenu / Sidebar 的 track 缝归零归 P18；Composer 归 P19；OpenInMenu 归 P20。
- web 独有 2（InternalBuildBanner、RcDeviceSwitcher）、desktop 独有 9（terminal/、window/、UpdateIndicator 等）：不动。
- `views/DesignSystemView.vue`：归 P22，不动。

**支撑模块**（被下沉组件引用，一并走）：

| 模块 | 两端状态 | 处置 |
|---|---|---|
| `components/chatTurnRendering.ts` | 字节一致 | 下沉 |
| `components/chat/tool-calls/{toolArgs,askUserToolParse}.ts` | toolArgs 仅首行注释差异，askUserToolParse 一致 | 下沉（toolRegistry 直接 import 14 个 tool .vue，须与组件同批，留 PR-B） |
| `components/admin/{pageItems,formatAdminTime,adminBatchToast,useAnchoredMenu}.ts` | pageItems/formatAdminTime/useAnchoredMenu 仅首行注释差异，adminBatchToast 一致 | 下沉 |
| `lib/toolMeta.ts`、`lib/activitySummary.ts` | 仅首行注释差异 | 下沉（消费方全在下沉集内） |
| `composables/useDialogFocus.ts` | 字节一致 | 下沉（另一消费方 SettingsDialog 是真实分叉留 app 侧，改从包 import） |
| `assets/{mascot,doodle}/*.riv` | 字节一致 | 下沉（KimiMascot/KimiDoodle 以 `?url` 引用，随包走相对路径） |

总计：**78 个 .vue + 10 个 .ts + 2 个资产文件**。

## 3. 包设计

### 3.1 独立成包，不并入 app-ui

下沉组件依赖 app-client（composables/client 单例）与 app-core，而 app-client 依赖 app-ui——并入 app-ui 会造成 app-ui ↔ app-client 反向依赖，破坏分层。故按主计划新建 `packages/app-components`。

### 3.2 package.json

照 app-ui 的 source-only 模式（`exports` 直指 `./src/*`，无构建脚本；消费方 bundler 转译）：

```jsonc
{
  "name": "@moonshot-ai/app-components",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@moonshot-ai/app-client": "workspace:*",
    "@moonshot-ai/app-composer": "workspace:*",
    "@moonshot-ai/app-core": "workspace:*",
    "@moonshot-ai/app-i18n": "workspace:*",
    "@moonshot-ai/app-markdown": "workspace:*",
    "@moonshot-ai/app-ui": "workspace:*",
    "@rive-app/canvas": "2.38.5",
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/xterm": "^6.0.0",
    "vue-i18n": "^11.4.5"
  },
  "peerDependencies": {
    "shiki": "^4.3.0",
    "vue": "^3.5.35"
  },
  "devDependencies": {
    "shiki": "^4.3.0",
    "typescript": "6.0.2",
    "vue": "^3.5.35",
    "vue-tsc": "~3.2.0"
  }
}
```

依赖依据（P4 教训：显式声明，不靠提升）：

- `vue-i18n`：下沉组件 58 处 `import { useI18n } from 'vue-i18n'`，版本对齐 apps（^11.4.5）。
- `shiki`：HighlightedCode 直接 import；peer + dev 对齐 app-core 既有写法（apps 已装 ^4.3.0）。
- `@xterm/xterm` + `@xterm/addon-fit`：Terminal.vue 使用（apps 侧自有副本继续保留，TerminalPanel 等 desktop-only 文件还在用）。
- `app-composer`：下沉集内 1 处 import（ChatPane 的 ComposerText）。

### 3.3 导出面

barrel `src/index.ts` 按 app-ui 惯例逐个命名导出（78 个组件名核对过无冲突，Terminal vs desktop-only TerminalView 不撞）：

```ts
export { default as ChatPane } from './chat/ChatPane.vue';
// …
export * from './chatTurnRendering';           // 测试与 app 侧真实分叉文件在用
export * from './admin/pageItems';
export * from './admin/adminBatchToast';
export { useDialogFocus } from './composables/useDialogFocus';
```

toolRegistry 直接 import 14 个 tool .vue，留 PR-B 与组件同批；toolMeta / activitySummary 的 `i18n.global.t` 绑定改为 app-client deps 的 `t` 注入缝（两端 main.ts 已注册，语义等价）。

## 4. 五类依赖缝的改法

下沉文件里的相对 import 按来源分流（符号不变，只改 specifier）：

| 原 specifier | 出现次数 | 改为 |
|---|---|---|
| `../types`、`../../types`、`../../../types`（app 侧 re-export 壳） | 41 | `@moonshot-ai/app-core/client/types` |
| `../api/types`、`../../api/types`、`../../../api/types`（re-export 壳） | 12 | `@moonshot-ai/app-core/api` |
| `../../api`、`../api` 的 `getKimiWebApi` 值 import（AuthMedia / MediaLightbox / Terminal） | 3 | `@moonshot-ai/app-client/client`（deps.ts 已有现成的注入缝 Proxy 实现 `getKimiWebApi`，**需补进 client/index.ts barrel 导出**——当前只导出了 setKimiClientDeps 等） |
| `./SessionRow.vue`、`./ThinkingBlock.vue` 等指向真实分叉文件的相对引用 | 见 §5 | 随 §5 解锁后全部同批下沉，相对路径不变 |
| `../lib/toolMeta`、`../../lib/activitySummary`、`../../composables/useDialogFocus`、`../assets/*.riv?url`、支撑模块间互相引用 | — | 随包下沉，相对路径保持不变 |

`track` 埋点（SessionRow / ThinkingBlock）按 P6 既定注入缝改造（web no-op，desktop 注册真实现），与 P18 对 ChatHeader/ApprovalCard/UserMenu/Sidebar 的做法同款——本批只做这两个文件，P18 范围相应缩小。SelectionActionBubble 首行注释改为中立措辞（不再写「synced with …」）。

## 5. 实施步骤（两个 PR）

### PR-A：包骨架 + 支撑模块 + 资产

1. 新建 `packages/app-components`（package.json 如上、`src/index.ts` 先导出支撑模块）。
2. `git mv`（以 web 侧副本为源保历史，desktop 副本删除）：chatTurnRendering.ts、tool-calls/{toolArgs,askUserToolParse}.ts、admin/*.ts ×4、lib/toolMeta.ts、lib/activitySummary.ts、composables/useDialogFocus.ts、assets riv ×2；.ts 文件首行 provenance 注释顺手删除（P13 同款）。toolRegistry.ts 因直接 import 14 个 tool .vue 留 PR-B。
3. **试点下沉 KimiMascot / KimiDoodle 两个组件**（消费方仅 ConversationPane / WorkingIndicator，且是 `?url` 资产唯一使用方）——在 PR-A 先验证 SFC +  riv 资产 + `@rive-app/canvas` 依赖的完整链路。
4. 两端 package.json 显式加 `@moonshot-ai/app-components: workspace:*` 依赖。
5. 改引用方 import：desktop 测试文件（chat-turn-rendering / turn-injection-boundary / turn-files-summary / sessionAdmin / activitySummary）、SettingsDialog（useDialogFocus）、两端 tool-calls 组件与 ActivityRun、两端 App.vue（adminBatchToast）、ConversationPane / WorkingIndicator（Kimi 组件）——此 PR 后其余组件仍在 app 侧，从包 import 支撑模块。
6. `client/index.ts` barrel 补 `getKimiWebApi` 与 `t` 导出（toolMeta / activitySummary 改走 `t` 注入缝）。
7. 台账同步：根 AGENTS.md（`apps/web` 依赖白名单加 app-components、目录地图加一行）、`apps/desktop/docs/native-todos.md`（admin「整目录手动同步副本」条目改写为支撑模块已下沉口径）；`apps/web/scripts/check-style.mjs` 扫描根加入 `packages/app-components/src`（ICON_EXEMPT 的 KimiMascot 键同步改前缀，§06 防线不留缺口）。

### PR-B：解锁 3 文件 + 78 组件全量下沉

1. 解锁：SessionRow / ThinkingBlock 的 track 改注入缝（diff 归零，双端 cmp 验证）；SelectionActionBubble 注释中立化。
2. `git mv` 78 个 .vue（web 为源，desktop 删除），barrel 补全部组件导出。
3. import codemod：两端 app 侧所有 `import X from '…/components/**.vue'`（指向已下沉文件）改 `import { X } from '@moonshot-ai/app-components'`；测试文件同步。
4. 包内相对 import 按 §4 表格分流改写。
5. 若 PR-B diff 过大，按目录拆 B1（tool-calls 17 + admin 5 + dialogs 5 + settings 6 + 顶层 12）/ B2（chat/ 33，含 ChatPane 依赖簇）。

## 6. 验证

- **零差异核对**：下沉前对全部 88 个文件跑 `cmp`（或 diff 行数统计）留档在 PR 描述；任何 >0 差异的文件不得进批（真实分叉以 native-todos 登记为准）。
- **五件套**：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm --filter kimi-code-web run check:style`（扩展后应覆盖新包且无新增 findings）、`pnpm build`。
- **双端巡检**（组件层第一次大搬家，主计划验收要求）：desktop 与 web 各全量页面人工巡检一遍，重点：chat 工具调用渲染、admin 会话管理页、settings provider 表单、媒体预览/lightbox、终端。
- **方向检查**：`grep -rn "from 'apps/" packages/app-components/src` 应为空；包不得 import app 侧模块。

## 7. 风险与回滚

- **误收真实分叉**：靠 §6 的 cmp 留档 + 逐文件人肉 diff 防线；发现误收即把该文件移回 app 侧并登记 native-todos。
- **`?url` 资产 / shiki / xterm 在包内解析**：source-only 包由消费方 Vite 处理，与 app-ui 现状同构；typecheck 走 apps 项目（`vite/client` 类型覆盖 `*?url`）。PR-A 先在 ChatPane 之外的轻文件上验证一遍链路，PR-B 再全量。
- **回滚**：两 PR 均纯移动，revert 即恢复。
