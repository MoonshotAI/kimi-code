# 会话管理页（Session Admin）实施计划

- 日期：2026-08-15（v2：按 kap-server 调研结论改为服务端分页/过滤/批量；v3：更新时间改 preset 下拉（3/7/30 天以前）、去掉会话 ID 列、状态列移到工作空间后、行内/批量主按钮改 accent 填充；v4：Gmail 式全选匹配——`fields=id,archived` 投影物化全部匹配 id、排除项、条件变更失效、>5000 分块执行）
- 原型：[`docs/prototypes/session-admin.html`](../prototypes/session-admin.html)（交互定稿以原型为准）
- 关联：PR #221（侧边栏状态标签视图）的后续项，见 [`2026-08-13-status-view-followups.md`](./2026-08-13-status-view-followups.md)
- 调研依据：kimi-code kap-server v2 sessions 实现（2026-08-15 调研，结论见文末附录）

## 背景与目标

会话（session）和 PR 一样有生命周期，但目前缺少一个集中管理入口：跨工作空间翻找旧会话、批量完成（归档）堆积会话都不方便。新增一个 admin 后台式的**会话管理页**，作为主内容区视图（左侧边栏保留），提供：

- 筛选：工作空间（多选）、状态（进行中/已完成）、更新时间范围
- 表格：会话 ID（点击复制）、状态、会话名、工作空间、最后一条 prompt、最后更新、完成时间、操作列
- 分页：页码 + 总条数 + 每页条数（10/20/50/100）——**服务端分页**
- 多选批量完成/重新打开（GitHub 式零位移批量表头）——**服务端批量端点**
- 入口：侧边栏「列表管理」dropdown 底部「会话管理…」

规模假设：**1 万条 session** 下全部交互保持即时。

## 服务端先行：kimi-code 侧三项改动（双仓工作流）

管理页的所有数据能力走 server，先在 kimi-code 工作克隆做这三个改动（对应 code-app 仓随后 bump submodule 指针）：

### S1：`GET /api/v2/sessions` 加页码模式 + total

现状（调研结论）：路由已把（workspace/archived 过滤后的）全集抽进内存做过滤排序（`kimi-code/packages/kap-server/src/routes/v2/sessions.ts:355-517`），keyset 游标是内存数组上的合成位置。因此：

- 响应 schema 无条件加 `total: number`（= 过滤后 `sorted.length`，零成本；游标模式同样受益）。
- 新增可选 `page`（1-based）与 `pageSize` 组合：`sorted.slice((page-1)*pageSize, ...)`，纯内存操作。
- `page` 与 `pageToken` **互斥**（同传报 40001）：页码模式无状态、不验指纹、不签发 token——每次请求自带完整条件，天然规避 40922 指纹机制与任意跳页的冲突。
- 语义声明：每页是独立快照（每请求重新抽干排序，无快照隔离），翻页间并发写入会让窗口平移——管理页场景可接受，与游标语义一致。

### S2：加 `updatedBefore` 过滤

- 对称于 `updatedAfter` 的边缘内存过滤一行（`v2/sessions.ts:430-432` 旁边）：`summary.updatedAt > updatedBefore → false`；schema + query 指纹各加一项。
- 历史上从未存在过（全仓 git 零命中），不是性能原因——`updatedAfter` 本身就无真实消费者，纯需求缺失。想下推存储也有现成列 bounds 机制（`sessionIndexService.ts:596-617`），但没必要。

### S3：批量端点 `POST /api/v2/sessions:archive` / `:restore`

- kap-server 无批量先例，沿用 action-suffix 约定：body `{ ids: string[] }`。
- 响应统一 envelope：`data: { results: [{ id, ok, error? }], succeeded, failed }`；单条不存在/已归档折叠进 per-item 结果，整体只在校验失败时 40001。
- archive 不动 `updatedAt`（既有保证，`43c68f58f`）——批量处理不会打乱管理页按 updated_at 的翻页排序。

**现有链路的物化开销（必须绕过）**：单条 archive 路由（`sessions.ts:887-894`）是先 `resume()` 再 `archive()`。这不是可选优化而是正确性要求——`archive()` 只认内存里活的 session handle（`sessionLifecycleService.ts:441`：`this.sessions.get(id)` 为 `undefined` 时**直接 return，连归档标记都不写**），它的主体是"关停活 session"的一串动作（写标记 → drain agents → 发事件 → 从 map 移除 → flush → dispose）。路由注释也明说了 "`resume` (not `get`) so archiving a freshly-opened cold session still works"。副作用是冷 session 被白白完整物化（session scope + main agent + MCP seed，`sessionLifecycleService.ts:394-419`），批量 N 条 = N 次物化——这是原"上限 500"护栏的真正来源。

**metadata-only 快路径（本次新写，现状不存在）**：对冷 session，`archive()` 里除 `setArchived(true)` + mirror + 发事件外全是 no-op（没有 agent 可 drain、没有 handle 可 dispose）。因此批量端点按条分流：

- 活 session（`this.sessions.get(id)` 有 handle）→ 走现有 `archive()` 完整流程；
- 冷 session → 不物化，直接等价三步：`ISessionMetadata.setArchived(true)`（原子写 `state.json`）→ mirror 进 read model → 发 `event.session.archived`。

restore 同理（`restore()` 同样先 `resume()`，`sessionLifecycleService.ts:459`；但 restore 通常紧接打开会话，物化不算浪费——批量 restore 也走同一分流，冷 restore 写 `setArchived(false)` + mirror + 事件，不预物化）。

**上限语义**：有了快路径，批量几千条 = 几千次原子文件写 + 一次统一 `indexMirror.drain()`，不再设 500 硬上限；仅保留一个防滥用工程上限 5000（超出 40001），活 session 占比较高的批次仍按 bounded concurrency（4–8）走原链路。末尾统一 drain 一次。

### 配套客户端 API 层（code-app 仓）

- `packages/app-core/src/api/types.ts:196`：`ListSessionsV2Input` 加 `page?: number`、`updatedBefore?: number`；`V2SessionsPage` 加 `total: number`。
- `packages/app-core/src/api/daemon/client.ts`：`listSessionsV2` 参数透传 + 新增 `archiveSessions(ids)` / `restoreSessions(ids)` 封装。
- 游标模式（侧边栏进行中等既有调用）完全不动。

## 架构决策（code-app 侧）

### 页面形态与路由

- facade 新增主视图状态：`mainView: 'chat' | 'sessionAdmin'`（`useWorkspaceState.ts` 的 `rawState` + `useKimiWebClient.ts` 导出），默认 `'chat'`。
- `App.vue`：`SessionAdminView` 与 `ConversationPane` 平级，`v-show` 切换（`ConversationPane` 保活，不丢聊天状态）。
- URL：扩展现有无 router 绑定（`'/' ↔ /sessions/<id>'`，`writeSessionUrl`）：进入管理页 `push '/admin/sessions'`，退出恢复既有逻辑；`load()` 深链解析识别该路径；`popstate` 同步 `mainView`。

### 入口

- `Sidebar.vue` 列表管理 dropdown（`chooseViewMode` 菜单）底部加分隔线 +「会话管理…」，`emit('openSessionAdmin')` → `App.vue` 置 `mainView='sessionAdmin'`；管理页打开时该菜单项行尾带 check。

### 数据策略（服务端分页）

- 页面状态：filters（workspaces[] / status / updatedAfter / updatedBefore）、page、pageSize、items、total、loading。
- 任一筛选/页码/条数变化 → 一次 `listSessionsV2` 请求（参数全量下推：`workspaceIds`、`archived` 三态、`updatedAfter`、`updatedBefore`、`sort='meta.updated_at_desc'`、`page`、`pageSize`）——无客户端聚合、无本地切片。
- 选中集跨页/跨筛选保留（GitHub 语义）；筛选变更时 page 归 1。
- 批量操作后：按响应 per-item 结果本地更新行状态（完成→移出/置灰按当前筛选），toast 计数用 `succeeded`；必要时静默重拉当前页。
- 进行中行的实时态不与管理页打通（页面只关心 open/done 生命周期）。

### 组件归属

- 新组件全部放 `apps/desktop/src/renderer/components/admin/`：`SessionAdminView.vue`（页面骨架+筛选栏）、`SessionAdminTable.vue`（表格+批量表头+操作列+右键）、`SessionAdminPagination.vue`、`MultiSelectMenu.vue`（工作区多选，checkbox 面板）。
- **不进 `app-ui`**：先页面私有，避免扩大 `check:style` 面；web 同步或复用时再提升。
- i18n：`packages/app-i18n` 新增 `admin` namespace（中英双份）。

## 分阶段实施

### P0：服务端三项（kimi-code 仓）+ code-app 指针对齐

- S1/S2/S3（见上）+ kap-server 侧单测（页码/total/互斥 40001、updatedBefore 边界、批量 per-item 结果与 5000 工程上限、冷/热分流正确性——冷归档不物化且行为等价）。
- code-app：`app-core` API 类型与 client 封装；工作克隆推后 bump submodule 指针。
- 验证：`curl` 直连验证三种查询与批量端点；code-app typecheck。

### P1：骨架与入口

- facade `mainView` + `/admin/sessions` URL 绑定（进入/退出/深链/popstate）。
- `App.vue` 挂 `SessionAdminView`（`v-show`）空骨架；`Sidebar.vue` 菜单加「会话管理…」。
- i18n namespace。验证：入口进出、URL 直达、聊天状态保留。

### P2：数据层 + 表格 + 筛选 + 分页

- `client/` 新模块：页面状态与请求编排（防抖、竞态丢弃旧响应、loading）。
- 表格组件（列序按原型）、筛选栏（状态 Select / 工作区 MultiSelectMenu / 时间范围控件）、分页组件（页码折叠 + 每页条数 + 共 N 条）。
- 验证：真实数据筛选联动、跳页、ID 复制、绝对时间列、双主题截图。

### P3：多选批量 + 右键 + 操作列

- 表头 checkbox（全选本页/indeterminate）+ 行 checkbox；表头原地变身批量条（零位移）。
- 批量完成/重新打开：调 S3 端点，按 per-item 结果更新 + `actionToast` 撤销（撤销=反向批量端点）。
- 操作列（主操作 + ⋯：重命名/Fork/导出，复用侧边栏链路）；右键单行/多选菜单；「打开会话」= `mainView='chat'` + `selectSession`。
- 与侧边栏状态互通：管理页完成后侧边栏进行中出列、已完成入列（复用 facade 本地剔除/入列逻辑）。
- 验证：批量流程 + 撤销、右键两形态、互通、双主题。

### P4：打磨与收尾

- `DesignSystemView.vue` 增补「会话管理页」模式节；原型 HTML 回同步。
- `tests/renderer/` 补数据层测试（参数映射、竞态丢弃、批量结果合并）；typecheck/lint/test 全绿。
- changeset（patch，仅 `kimi-code-app`）。
- **web 同步评估**：两端共有 UI，desktop 先行后同步 `apps/web`；不同步则在 `native-todos.md` 登记分叉。

## 风险与开放问题

- **read model degraded**：每请求退化为 N 次 `state.json` 文件读（1 万条有感）。管理页调用频率低（人工操作），可接受；观测靠既有 warn 日志 + degraded 计数（`sessionIndexService.ts:295-308`）。
- **批量快路径的等价性**：S3 的冷/热分流依赖"冷 session 上 `archive()` 除写标记/mirror/事件外全是 no-op"这一代码事实（`sessionLifecycleService.ts:441-457`），单测必须覆盖（冷归档后 meta/read model/事件与热路径一致、活 session 仍完整 drain/dispose）。
- **选中跨页/跨筛选保留**：批量条计数含不可见行；toast 以响应 `succeeded` 为准，跳过数在文案体现。
- **`lastPrompt` 空值**：占位「—」。
- **侧边栏入口发现性**：菜单层级变深，不足时后续在侧边栏底部加二级入口。

## 验收清单

- [ ] server：页码+total（含与 pageToken 互斥 40001）、updatedBefore、批量 archive/restore（5000 工程上限、per-item 结果、冷/热分流）单测绿
- [ ] 入口进出管理页，URL `/admin/sessions` 直达与前进后退
- [ ] 筛选/跳页/改条数均一次请求即时响应，总数精确；1 万条规模人工抽查响应时延
- [ ] ID 点击复制；绝对时间列；批量操作 + 撤销；表头零位移
- [ ] 右键单行/多选菜单；操作列 ⋯ 三项可用
- [ ] 与侧边栏状态互通（完成→进行中出列、已完成入列）
- [ ] 双主题截图；typecheck/lint/test 全绿；changeset；submodule 指针 bump

## 附录：kap-server 调研结论（2026-08-15）

- **链路**：`GET /api/v2/sessions`（`registerApiV2Routes.ts:22-29` → `routes/v2/sessions.ts:355-517`）→ `ISessionIndex.listRecent` 抽干（workspace/archived 过滤后的）全集 → 路由内存完成 statuses/updatedAfter/archived=true 过滤、三种 sort、keyset 切片（`v2/sessions.ts:428-465`）。
- **存储**：minidb 读模型（`<home>/cache/query-store`，16 shard ClusterDb，`valueMode: 'memory'`，snapshot+WAL），权威数据是 per-session `state.json`；degraded 时回退目录树全量文件读（`sessionIndexService.ts:642-740`）。
- **游标**：base64url `{v, f: 查询指纹, k: [sortKey, id]}`，指纹=排序后全部条件的 sha256 截 16 字符；翻页改条件报 40922（防止静默窗口漂移，`v2/sessions.ts:12-16, 240-289`）。
- **updatedBefore**：全仓历史从未存在；`updatedAfter` 为 kimi-inspect 表格面板一次性设计（`6f1cd7ca2`，PR #2640）且无真实消费者。非性能原因。
- **lastPrompt**：session meta 一等字段（`sessionIndex.ts:48`），内存读模型直达，无 transcript 文件读。
- **批量**：kap-server 无批量端点先例；无跨 session 事务需求。关键坑：单条 archive 必须先 `resume()` 再 `archive()`（`sessions.ts:887-894`），因为 `archive()` 只认活 handle、冷 session 直接 return 不写标记（`sessionLifecycleService.ts:441`）——代价是冷 session 被完整物化。批量端点因此按冷/热分流（活走原链路，冷直接 `setArchived` + mirror + 事件，行为等价），避免 N 次物化。
