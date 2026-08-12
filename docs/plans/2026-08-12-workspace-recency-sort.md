# Workspace 分组视图 recency 排序 实施方案

> 2026-08-12。恢复 dir 分组视图的「按最新时间排序」模式（2026-07-31 PR #164 删除，见下文历史节），并按本次拍板修复其删除动因。已拍板决策：
>
> 1. 组间 recency 键 = **组内最新 session 的 `updatedAt`**；**归档 / 删除锚 session 不触发组间重排**（recency floor，单调不减）。
> 2. 空组（无 session）用 wire 的 **`last_opened_at`** 作排序键下限——刚添加的 workspace 自然浮顶，有 session 活动后活动接管。
> 3. **手动拖拽序保留且为默认模式**；recent 为可选模式（选项加回侧栏视图菜单）。
> 4. 首次（本地无存储序）默认顺序**纯前端**用 `last_opened_at desc` 初始化，**server 零改动**。
>
> 本计划推翻 `docs/specs/2026-08-11-session-status-and-ordering.md` 背景节「分组视图组间手动序不动」的拍板（同一决策人，落地时同步更新该 spec 第二章）。

## 历史与现状（调研结论，代码引用为准）

### 被删功能时间线

| 时间 | PR | 事 |
|---|---|---|
| 早期 | — | `WorkspaceSortMode = 'manual' \| 'recent'`（localStorage `kimi-web.workspace-sort`）；`sortWorkspacesByRecent` 按组内最新 session `updatedAt` 降序；WORKSPACES 头部 ⋯ 菜单里两个 check 项 |
| 07-20 | #49（`96d9890d`） | 修 recent 模式两 bug：新 workspace 无活动沉底（本地盖 `workspaceAddedAt` 戳）；点开运行中 session 吃进 server mid-turn `updatedAt` 致组浮顶（main turn 期间持有本地 `updatedAt`，该保护至今仍在 `syncSessionFromSnapshot`） |
| 07-31 | #164（`5272a23f`） | **删除 recent 模式**。原话："archiving an anchor session collapsed the workspace's recency and reshuffled the sidebar" —— 归档锚 session 后组 recency 塌掉、侧栏洗牌 |
| 08-06 | #183 | 平铺视图引入 |
| 08-12 | #201（`aa78dac9`） | 状态枚举 + 纯时间序；spec 拍板「组间手动序不动」（本次推翻） |

### 现状事实

- **组内**：`buildWorkspaceGroups`（`apps/web/src/composables/useKimiWebClient.ts:3062`）对共享 pool 按 `updatedAt` desc 排序后分桶，与平铺视图（:2931）同键同源；#201 已把 restore/fork/create/undo 统一为按时间有序插入。**组内与平铺一致性已成立，本次不涉及**。
- **组间**：仅手动序。`workspacesView` = `sortByWorkspaceOrder(views, workspaceOrder)`（:2837），序持久化于 `kimi-web.workspace-order`；reconcile watcher（:2784）prepend 新 id；拖拽经 `reorderWorkspaces`（:3159）。
- **接口**：`GET /api/v1/workspaces` 不排序，返回 `workspaces.json` append 序（新 workspace 在最后；`kimi-code/packages/kap-server/src/routes/workspaces.ts:100`，`workspaceService.ts:148`）。wire 带持久化的 `created_at` / `last_opened_at`（`workspaces.ts:337-338`，文件头 "reset on restart" 注释已过时）；`AppWorkspace.lastOpenedAt` 已接（`packages/app-core/src/api/types.ts:251`）。
- **分页安全性**：组键只需每组 max(updatedAt)，server `updated_at_desc` 契约 + 客户端 per-workspace 第一页本地重排（`useWorkspaceState.ts:919`）保证第一页首条即全组最新，无需全量加载。workspace 列表本身不分页（全量返回）。

### 关键落点现状（P 系迁移后）

- 纯函数：`packages/app-core/src/lib/workspaceOrder.ts`（现仅 `reconcileWorkspaceOrder` / `sortByWorkspaceOrder` / `moveInOrder`）。
- storage：`packages/app-core/src/lib/storage.ts`（`loadSidebarViewMode` :181、`loadWorkspaceOrder` :196 同文件）。
- facade：`apps/web/src/composables/useKimiWebClient.ts` + `apps/desktop/src/renderer/composables/useKimiWebClient.ts`（同步副本，保留各自分叉块）。
- 菜单：`Sidebar.vue` 视图菜单（`view-menu`，:1151 起，现有 label + flat/grouped 两项 + check 形态）；i18n 在 `packages/app-i18n/src/locales/{en,zh}/sidebar.ts`。
- 测试：`apps/web/test/workspace-order.test.ts` 现存（#164 只删了 recent 用例）；app-core 测试在 `packages/app-core/test/`。

## 改动方案（单 PR，desktop 先行、同步 web）

### 1. 纯函数层 `packages/app-core/src/lib/workspaceOrder.ts`

- 恢复 `export type WorkspaceSortMode = 'manual' | 'recent'`。
- 新增 `sortWorkspacesByRecent<T extends { id: string }>(items: T[], recencyKey: ReadonlyMap<string, number>): T[]`：按 key 降序，无 key 项视为 `-Infinity` 沉底；`toSorted` 稳定排序（同键保持相对序）。
- 新增 `reconcileRecencyFloor(floor, currentKeys): { next, changed }` 纯函数：对每个 id 取 `max(旧 floor, 当前键)`，输出新表 + 是否变化（调用方据此节流持久化）。删除已不存在 id 的条目的工作不在这里做（见 §3 删除路径）。
- `reconcileWorkspaceOrder` 扩展可选参 `initialRank?: ReadonlyMap<string, number>`：**仅当 stored 为空**（首次）时，新 id 按 rank 降序排列（替代接口 append 序）；stored 非空时新 id 仍 prepend（现状不变）。
- `lib/index.ts` 补导出。

### 2. storage `packages/app-core/src/lib/storage.ts`

- 恢复 `STORAGE_KEYS.workspaceSort = 'kimi-web.workspace-sort'` + `loadWorkspaceSort(): WorkspaceSortMode`（非法值/缺失回退 `'manual'`）/ `saveWorkspaceSort`。
- 新增 `STORAGE_KEYS.workspaceRecencyFloor = 'kimi-web.workspace-recency-floor'`：`Record<string, number>`（epoch ms），load 校验有限数、save 直写。

### 3. facade 两端 `useKimiWebClient.ts`

- `const workspaceSortMode = ref<WorkspaceSortMode>(loadWorkspaceSort())`；`setWorkspaceSortMode(mode)` 写 ref + 持久化；经 facade 导出（沿 #164 前 `:workspace-sort-mode` / `@set-workspace-sort-mode` 接线形态，App.vue 两端同步）。
- `const workspaceRecencyFloor = ref<Record<string, number>>(loadWorkspaceRecencyFloor())`。
- watch（`rawState.sessions` 的 id+updatedAt 指纹）：对每个可见 workspace 算 `当前键 = max(未归档 session.updatedAt)`（child session 排除，同 `buildWorkspaceGroups` 口径），调 `reconcileRecencyFloor`；`changed` 时写 ref + 节流 `saveWorkspaceRecencyFloor`。**归档/删除使当前键变小时 floor 不动 → 组不重排**；其他组新活动自然超过。
- `workspacesView`：recent 模式 → `sortWorkspacesByRecent(views, keys)`，键 = `max(floor[id] ?? 0, Date.parse(lastOpenedAt ?? ''))`（`lastOpenedAt` 兼作空组下限：新加 workspace `createOrTouch` 刷新它 → 浮顶）；manual → 现状。
- 首次初始序：reconcile watcher 调 `reconcileWorkspaceOrder` 时传 `initialRank`（id → `Date.parse(lastOpenedAt)`）。
- `deleteWorkspace` / `applyWorkspaceEvent(workspaceDeleted)`：清 floor 条目并保存。（实现注记：落地时改为在 reconcile watcher 里用 `pruneRecencyFloor` 统一 GC——与 reconciler 共用 loading 守卫，覆盖本地删除 / 远程事件 / 隐藏全部路径，各删除调用点零改动。）
- ~~loading 保护~~（实现注记：无需单独的 loading 逻辑——floor 持久化意味着刷新后键的初值就是上次的最终值，`last_opened_at` 又只读，键整体单调，组从不下移，天然无闪跳）。

### 4. UI `Sidebar.vue`（两端同步）

- 视图菜单（`view-menu`）加第二节：label「排序方式 / Sort order」+ `sortManual` / `sortRecent` 两个 `MenuItem`（沿用现有 icon + 文本 + 右侧 check 形态）。**仅 grouped 模式显示该节**（flat 模式无组间序概念）。
- props/emits 恢复：`workspaceSortMode: WorkspaceSortMode`、`set-workspace-sort-mode`；App.vue 两端接线。
- recent 模式下组头拖拽禁用（`draggable=false`、dragover/drop 不响应），避免"拖了不生效"的假象；manual 模式拖拽逻辑一行不动。
- i18n：`packages/app-i18n/src/locales/{en,zh}/sidebar.ts` 加 `sortLabel`（排序方式 / Sort order）、`sortManual`（手动排序 / Manual）、`sortRecent`（按最近活动 / Recent activity）。

### 5. 测试

- `packages/app-core/test/`（新文件或并入现有 workspace-order 用例，按当前归属）：`sortWorkspacesByRecent`（降序、无键沉底、同键稳定）；`reconcileRecencyFloor`（单调不减、键增大才 changed）；`reconcileWorkspaceOrder` 的 `initialRank` 分支（空 stored 按 rank、非空 stored prepend 不变）。
- `apps/web/test/workspace-order.test.ts`：恢复 recent 相关用例的客户端侧覆盖（若纯函数测试已全量覆盖则此处只补 facade 层）。
- facade 层（`workspace-state.test.ts` 或新文件）：模式持久化、归档/删除锚 session 后 floor 不变、新 workspace 以 `lastOpenedAt` 浮顶、删除 workspace 清 floor 条目。

### 6. 文档与 changeset

- 更新 `docs/specs/2026-08-11-session-status-and-ordering.md`：背景节「不做」清单移除该条，第二章组间排序改为「手动序（默认）/ recency 序（可选）+ floor 语义」。
- changeset 走 `changeset` skill：`patch`，只写 `kimi-code-app`，一句面向用户的中文描述（恢复按工作区最近活动排序选项）。

## 验证

- `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm --filter kimi-code-web run check:style`（改动文件不新增 findings）。
- 手测脚本（亮 + 暗双主题）：
  1. grouped + recent：新建 workspace → 浮顶；发首条 prompt → recency 键接管（位置不变或按活动落位）。
  2. 归档组内最新 session → 组**不动**；删除该 session → 组**不动**；另一组发 prompt → 超过它。
  3. recent ↔ manual 切换 → 各自顺序正确；manual 拖拽 → 持久化；切走再切回 → 手动序还在。
  4. 刷新 → 两种模式顺序均保持；清空 localStorage 首次打开 → 按 `last_opened_at desc`。
  5. 菜单在 flat 模式不显示排序节；recent 模式组头不可拖。

## 风险与备注

- floor 单调不减 = 删除锚 session 后组停原时间位（拍板行为）；跨设备不同步（per-device，与手动序一致）。
- 老数据 `last_opened_at` 为 rebuild 时刻的统一 now → 首次初始序退化为接口 append 序，可接受。
- server（kimi-code 仓）零改动；若未来想要接口级排序另立项。
- workspace 若未来分页，`reconcileWorkspaceOrder` 的部分集合问题先于本功能暴露（现有保护注释已提示），不在本次范围。
