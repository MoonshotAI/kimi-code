# 侧栏新增「平铺 session」视图（/api/v2/sessions，前端 mock）

## 背景与目标

侧栏会话列表目前只按 workspace 分组展示。新增第二种维度：**平铺**（全局 `updated_at` 倒序）。WORKSPACES header 右侧加切换 icon，**默认平铺**。平铺行两行：标题行 + 第二行（小文件夹 icon + 所属工作目录，cwd 为 null 显示 `-`）。数据契约按飞书文档 `GET /api/v2/sessions`（本地副本 `.tmp/v2-sessions-api.md`）；**服务端尚未实现该接口，前端先 mock**。

已确认的产品决策：① 先 mock；② 平铺 = 全局 updated_at 倒序 + 滚到底加载更多；③ 切换 icon 不常驻（沿用现有 hover 显现）；④ cwd null 显示 `-`；⑤ view mode 持久化 localStorage。

## 总体架构（单一事实源）

`rawState.sessions` 仍是唯一 session 池；v2（mock）分页只负责**把更老的 session 拉进池子**，平铺视图是池子上的一个 computed。这样 WS 实时更新（标题/状态/徽标）、新建会话置顶、归档消失全部免费获得，与文档「本接口只做基线 seed，增量靠 WS」一致。

```
Sidebar(viewMode=flat) → emit ensureFlatSessions / loadMoreFlatSessions
  → App.vue → client(useWorkspaceState) → web-core client.listSessionsV2()
      → MOCK 开关 = mock：mockV2Sessions.ts 用 v1 listSessions 全量数据合成 v2 分页响应
  → 响应条目 toAppSessionFromV2() 映射后 upsert 进 rawState.sessions（已在池中的保留 live 数据）
  → facade flatSessions computed：过滤+排序+投影（含 cwdLabel）→ Sidebar 渲染 SessionRow（新增第二行）
```

真接口上线时只需把 web-core 里的实现开关从 mock 拨到 real（代码注释标明）。

## 实现步骤

### 1. web-core：v2 类型 + client 方法 + mock（共享包，两端一次到位）

- `packages/web-core/src/api/types.ts`：新增
  - `V2SessionActivityStatus = 'running'|'approval'|'question'|'failed'|'idle'`
  - `V2Session`（按文档 domain 结构：`id`、`workspace:{id,cwd:string|null}`、`meta:{title:string|null,last_prompt,created_at,updated_at,archived}`、`activity:{status}`；`git` 不做，mock 阶段不用 include=git）
  - `V2SessionsPage = { items: V2Session[]; hasMore: boolean; nextPageToken: string | null }`
  - `ListSessionsV2Input = { workspaceIds?; statuses?; updatedAfter?; archived?: boolean|'all'; sort?; pageSize?; pageToken? }`
- `packages/web-core/src/api/daemon/mockV2Sessions.ts`（新文件）：`mockListSessionsV2(listAll, input)` —— 从 v1 全量（`listSessions({ excludeEmpty: true })`，不传 page_size = 全量；excludeEmpty 与现有侧栏语义一致，注释注明 v2 文档无此参数、属 mock 行为）合成：
  - 映射 `AppSession → V2Session`：busy/mainTurnActive→running；pendingInteraction→approval/question；lastTurnReason==='failed'→failed；其余 idle；`meta.title` 空串→null（走文档 fallback）
  - 过滤：archived（默认排除，`'all'` 全返）、statuses、workspaceIds（匹配 `workspaceId ?? cwd`）、updatedAfter
  - 排序：`meta.updated_at_desc`（默认）/`_asc`/`created_at_desc`
  - 分页：pageSize 默认 50（1–100，越界抛 invalid_param）；cursor = base64url(JSON `{s: offset, q: 参数指纹}`)，指纹不一致或游标损坏 → 抛 `DaemonApiError({ code: undefined, msg: 'page_token_mismatch', requestId: 'mock', details: { code: 'page_token_mismatch', status: 409 } })`（v2 文档错误码是字符串、v1 是数字 envelope，mock 用 details 承载；真接口阶段的 envelope 差异在代码注释标明）
- `packages/web-core/src/api/daemon/client.ts`：`listSessionsV2(input): Promise<V2SessionsPage>` —— 模块级开关 `const V2_SESSIONS_SOURCE: 'mock'|'real' = 'mock'`（注释：真接口落地后拨到 'real'）；mock 分支委托上面的 mock（listAll 用 `this.listSessions({ excludeEmpty: true })`）；real 分支实现真实调用（query 支持重复参数 `workspace.id`/`activity.status`；URL 前缀 `/api/v2`，在 `config.ts` 加 `buildRestUrlV2` 或给 http 加前缀参数，取最小改法）
- `packages/web-core/src/api/daemon/mappers.ts`：`toAppSessionFromV2(v2: V2Session): AppSession` —— 标题按文档 fallback（title → last_prompt → id 前 12 位）；ms→ISO；activity 反向映射回 busy/pendingInteraction/lastTurnReason；`cwd: workspace.cwd ?? ''`；usage 用现有 placeholder 零值写法（参照 `isPlaceholderSessionUsage` 配套）；messageCount/lastSeq 置 0（注释：v2 无这些 domain，详情在打开会话时按现有 /status 路径加载）
- 单元测试（放 web-core 现有测试目录结构内，实现时 glob 确认）：排序三种、各过滤器、archived 默认排除、分页切片 + token 往返 + has_more、参数变了翻页→409、toAppSessionFromV2 的 fallback/映射

### 2. desktop 数据层

- `apps/desktop/src/renderer/composables/useKimiWebClient.ts`
  - `ExtendedState` + `rawState` 初始值加：`flatSessionsNextPageToken: string|null`、`flatSessionsHasMore: boolean`、`flatSessionsLoading: boolean`、`flatSessionsLoadingMore: boolean`、`flatSessionsSeeded: boolean`
  - 新增 `flatSessions` computed：池内过滤（非子会话、!archived、workspace 可见、**排除 pinned**——pinned 在置顶区渲染，保持"一条会话只出现一次"，与分组模式一致）→ updatedAt 倒序 → 投影 `Session`（含 `cwd: s.cwd`、`cwdLabel: s.cwd ? shortenHome(s.cwd, rawState.fsHome) : '-'`、updatedAt、workspaceName；复用 `sessionTimeClock`）
  - return 导出：`flatSessions`、`flatSessionsHasMore`、`flatSessionsLoadingMore`、`ensureFlatSessions`、`loadMoreFlatSessions`（动作来自 useWorkspaceState 注入，参照现有 `loadMoreSessions` 接线）
- `apps/desktop/src/renderer/composables/client/useWorkspaceState.ts`
  - `ensureFlatSessions()`：已 seed 或 loading 直接返回；否则拉首页（pageSize 50）→ upsert → 写 cursor/hasMore/seeded
  - `loadMoreFlatSessions()`：hasMore && !loadingMore 时带 token 拉下一页 → upsert；捕获 `page_token_mismatch`（`isDaemonApiError(err) && err.details?.code === 'page_token_mismatch'`）→ 丢游标从首页重拉（按文档约定）
  - upsert：按 id 去重，**池中已有条目不动（live 数据优先）**，新条目用 `toAppSessionFromV2` 追加；不动 `sessionsHasMoreByWorkspace` 等分组游标状态

### 3. desktop UI

- `apps/desktop/src/renderer/types.ts`：`Session` 加 `cwdLabel?: string`（注释：平铺模式第二行展示文本，facade 已做 home 缩写与 `-` 兜底）
- `apps/desktop/src/renderer/lib/storage.ts`：`STORAGE_KEYS.sidebarViewMode = 'kimi-web.sidebar-view-mode'` + `loadSidebarViewMode()`（校验 'flat'|'grouped'，**默认 'flat'**）/ `saveSidebarViewMode()`
- `apps/desktop/src/renderer/components/SessionRow.vue`（两端当前逐字节一致，改完保持一致）：`.row` 之后加
  ```html
  <div v-if="session.cwdLabel !== undefined" class="sub">
    <Icon name="folder" size="sm" /><span>{{ session.cwdLabel }}</span>
  </div>
  ```
  - 样式全部走 token：与标题对齐（`margin-left: calc(var(--sb-gutter) + var(--sb-gap))`），字号 `--text-xs`、颜色 `--color-text-faint`，尾部截断方式参照 `.t` 的 mask 渐隐；**动手前先读 `DesignSystemView.vue` §07 Session row** 确认行高/间距约定；grouped/pinned 不传 cwdLabel，渲染零变化
- `apps/desktop/src/renderer/components/Sidebar.vue`
  - state：`viewMode = ref(loadSidebarViewMode())`；切换时 `saveSidebarViewMode` + `emit('ensureFlatSessions')`；onMounted 若 flat 也 emit 一次
  - header（`.side-section-actions`，约 910-923 行）：label 文案 `viewMode==='flat' ? t('sidebar.sessionsHeader') : t('sidebar.workspaces')`（`sessionsHeader` 是现成的 key，en/zh 都是 'sessions'，CSS 大写）；新增切换 IconButton（class 沿用 `side-section-toggle` = hover 显现；icon `viewMode==='flat' ? 'tree-view' : 'list'`，两端的 `lib/icons.ts` 均已注册这两个图标）；collapse-all 按钮加 `v-if="viewMode === 'grouped'"`
  - header 显隐条件：`viewMode==='grouped' ? groups.length > 0 : true`（平铺下无会话也保留 label 行以便切回）
  - 列表区：grouped 块加 `v-if`；新增 flat 块：`v-for s in flatSessions` 直接渲染 `SessionRow`（props/事件与 WorkspaceGroup 内行一致：`:active`、approval/question counts、`unreadBySession`、select/rename/archive/fork/export/pin → 复用 Sidebar 现有 handler）；底部 `flatLoadingMore` 时渲染 Spinner + `t('sidebar.loadingMore')` 行；空态（seed 完且无会话）显示 `t('sidebar.noSessions')`
  - 平铺行的拖拽（对齐分组模式的置顶交互）：
    - **拖到置顶区置顶**：行容器 `draggable="true"` + dragstart 写入 `SESSION_ROW_DRAG_MIME`（WorkspaceGroup.vue:261-262 同款 marker），PinnedSessionList 现有的 `pinSessionAt`（按落点位置插入）逻辑直接生效，无需改动
    - **置顶行拖回平铺列表取消置顶**：flat 列表容器整体作为 pinned drag-back 的 drop target（dragover preventDefault + `dropEffect='move'` → drop 时走现有 `onDropPinnedSession` 取消置顶；visual affordance 参照 `.group.pinned-drag-active` 的 accent 框）；分组模式下"只有原 workspace 组可拖回"的限制在平铺模式不适用（列表本来就是全部会话）
    - **置顶区内部拖拽排序**：PinnedSessionList 自带、与模式无关，零改动
    - **平铺列表本身不做手动排序**：它是全局 updated_at 倒序（v2 契约 + 分页），手动顺序与之冲突；分组模式组内同样不允许手动排——要固定位置就用置顶
  - 滚动加载：扩展现有 `onSessionsScroll`/`updateSessionsScrollState` —— flat 且距底 < ~200px 且 `flatHasMore && !flatLoadingMore` → `emit('loadMoreFlatSessions')`（不加 IntersectionObserver，复用一个滚动路径）
  - emits 增加：`ensureFlatSessions: []`、`loadMoreFlatSessions: []`
- `apps/desktop/src/renderer/App.vue`（约 1359-1395 的 Sidebar 接线）：传 `:flat-sessions="client.flatSessions"`、`:flat-has-more`、`:flat-loading-more`，绑 `@ensure-flat-sessions`、`@load-more-flat-sessions` → 对应 client 动作
- `packages/web-i18n/src/locales/en/sidebar.ts` / `zh/sidebar.ts`（共享包）：加 `viewFlat: 'Flat list' / '平铺列表'`、`viewGrouped: 'Group by workspace' / '按工作区分组'`

### 4. 验证（desktop）

- `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm --filter kimi-code-web run check:style`（改动文件不得新增 findings）
- 视觉验证（仓库硬要求）：`pnpm dev:desktop:debug`（9222 端口）起桌面端，经 CDP 远程调试截图核对——默认进平铺、两行布局、文件夹 icon、`-` 兜底、hover 动作/右键菜单、切换 icon 的 hover 显现与来回切换、刷新后持久化、亮色+暗色；分组模式回归（折叠/show more/pinned/拖拽）
- 本地数据不足 50 条时滚动分页以单测覆盖为准，视觉只验首屏

### 5. 同步 web 端（仓库纪律：先 desktop 后 web）

- 逐文件 diff 同步，保留各自分叉块（`native-todos.md` §10/11/59/121/134/156/182-186：品牌标、dev pill、快捷键、track、log 前缀、vibrancy）：`Sidebar.vue`、`useKimiWebClient.ts`、`useWorkspaceState.ts`（手工 merge）；`SessionRow.vue`、`types.ts`、`lib/storage.ts`（同步前 diff 确认是否逐字节一致，一致则直接拷贝）
- web-core / web-i18n 是共享包，无需同步
- 同步后重跑 typecheck/lint/test；必要时在 `apps/desktop/docs/native-todos.md` 补一条本次同步记录

### 6. changeset

- 按 `changeset` skill 执行：**patch**、只写 `kimi-code-app`、一句面向用户的中文描述

## 明确不做（本次范围外）

- `include=git`（branch/PR 展示）、`activity.status`/`workspace.id` 筛选 UI、移动端 switcher 平铺、平铺列表手动排序（见下）、真接口联调（等 kap-server 实现 `/api/v2/sessions` 后拨开关 + 对齐 envelope 差异）

## 待确认的决策点

1. 平铺模式 header 文案切换为 "SESSIONS"（复用现成 `sidebar.sessionsHeader` key），分组模式仍是 "WORKSPACES"
2. 平铺列表排除 pinned 会话（与分组模式"置顶只出现一次"语义一致）
3. 置顶相关拖拽全保留（拖入置顶、置顶区内排序、拖回取消置顶），但平铺列表本身不做手动排序——全局 updated_at 倒序是 v2 契约，分组内现在也不能手动排；要固定某条会话的位置就用置顶

## 切换真接口（2026-08-05，已实现）

服务端 `GET /api/v2/sessions` 落地（kimi-code #2640 + #2644），submodule bump 到 `510fbe7ec`。与文档/首版假设的差异及对齐：

- **envelope**：v2 最终裹 v1 的 `{code,msg,data,request_id}`（#2644），`httpV2.get` 直接复用 unwrap；业务错误码为数字 `40001`（参数非法，details 带字段表）/ `40922`（`PAGE_TOKEN_MISMATCH`）——`isPageTokenMismatchError` 改按 `err.code === 40922` 判定（`V2_PAGE_TOKEN_MISMATCH_CODE`，web-core api/errors.ts），不再用 mock 的 details.code 字符串
- **mock 拆除**：`mockV2Sessions.ts` 与 `V2_SESSIONS_SOURCE` 开关删除，`listSessionsV2` 只剩真路径；web-core 测试改为真路径（envelope unwrap、query 透传、40922 判定）+ 保留 `toAppSessionFromV2` 用例
- **空会话**：v2 无 `exclude_empty` 参数——入池时按 v1 语义（`last_prompt` 为空即空会话）跳过新条目；已在池中的（本地新建）保持可见
- **PR draft 态**：服务端把 `draft` 折叠为 `open`（mock 曾置 null，已随 mock 删除）
- **submodule API 适配**：`ISessionIndex.countActive(ids)` → `count({workspaceIds})`（`src/main/telemetry.ts`）
- 实测：内嵌新 server 起 dev，`page_size=50&include=git` 首页 + `page_token` 续页正常，滚到底自动 drain 622 条，无空会话泄漏（无 id 前缀兜底标题），PR chip 真实数据渲染

## 评审修订（2026-08-04，已实现）

首版评审后按以下反馈调整，两端均已同步：

1. **Header 统一为 SESSIONS**，不再随视图切换（`sidebar.workspaces` key 不再用于侧栏 header）
2. **切换按钮改为 dropdown**：点击弹出菜单选择视图（平铺列表 / 按工作区分组），当前项带勾选（复用 backend 菜单的 `.section-menu-check` 模式）；按钮 icon 跟随当前视图，tooltip `sidebar.viewSwitcher`（新增 key）
3. **平铺行左对齐**：去掉前导状态槽，标题从行内容左缘开始
4. **第二行只显示最终目录名**（`basename`，无 cwd 仍显示 `-`），不再显示全路径
5. **状态右置顶替时间**：平铺行第一行右侧显示状态（待回答/待审批/已中止 pill、运行中 spinner、未读蓝点），有任何状态时不显示时间；无状态才显示时间；hover 动作（pin/归档）照常覆盖该区域

二次评审（切换器视觉，对齐飞书视图菜单截图，已实现）：

- **按钮 icon 固定**为 `list-settings`（ri `list-settings-line`，新注册进两端 `lib/icons.ts`；设计 skill 的 Kimi 图标库无"视图选项"语义匹配，按 skill 规则取最接近的外部图标），不再随当前视图变化
- **按钮 hover 出 tooltip**「视图选项 / View options」（`sidebar.viewSwitcher` 值同步调整）
- **dropdown 加"视图/View"分组标签**（新增 `sidebar.viewGroup` key；`.view-menu-label` 样式）
- **勾选项右置**：菜单项左侧为各视图自己的 icon（list / tree-view），当前视图的 check 移到行右缘（`.view-menu-check`）
- **视图切换按钮固定在 section actions 最右**（折叠/展开按钮在其左）
- **pill 与 loading 互斥**：有待授权/待回答 pill 时不再显示运行中 spinner（busy 在等待输入期间仍可为 true）；状态判定逻辑抽成纯函数 `components/sessionRowStatus.ts`（两端各一份），单测 `tests/renderer/sessionRowStatus.test.ts` / `apps/web/test/sessionRowStatus.test.ts` 各 10 条钉住规则
- **第二行图标可读性修复**：`folder`（open）在 14px + faint 下左侧薄边弧线被视觉"截断"，改用 `folder-closed`（闭合文件夹轮廓完整）并把图标色提到 `--color-text-muted`（与组头 `.gh-folder` 同款小尺寸光学补偿）；排查过程确认几何与绘制无裁剪（全不透明红色实验），属字形笔画在小尺寸低对比下的辨识度问题
- **pill 钉在行右缘 + hover 覆盖**：pill 收进 `.act` 槽（无时间显示时贴行右缘）；平铺行 hover 时整个状态簇（pill/spinner/未读点）淡出、pin/归档在原位淡入，两者不同时出现（分组行 hover 行为不变：pill 保持可见）
- **置顶区恒为平铺行样式**：置顶区本身就是平铺列表，其行无论什么视图模式都用平铺样式（facade 的 `pinnedSessions` 投影也带 `cwdLabel`，SessionRow 的 flat-style 变体由此触发）；与平铺列表的行标题 x 对齐（两侧都是 `--sb-pad-x`）
- **header 中文化**：`sidebar.sessionsHeader` 中文值「会话列表」（英文仍 sessions，CSS 大写为 SESSIONS）
- **置顶区与列表标签间距**：`.pinned + .side-section-label` 加 `margin-top: var(--space-2)`（仅在置顶区存在时生效）
- **移除置顶行的 hover tooltip**（原来显示 `工作区名 · 完整路径`，第二行目录名已承担定位作用）：`PinnedSessionList` 去掉 Tooltip 包装与 `tooltipFor`；`Session.cwd` 视图字段的最后一个消费者随之消失——但 `sessions` 投影补上 `workspaceId`/`cwd` 时保留了该字段（见下）
- **顺带修复一个既有 dead code**：`App.vue` 删除工作区时按 `workspaceId`/`cwd` 匹配会话清理终端桶，但 facade 的 `sessions` 投影从未带这两个字段，匹配恒为空（PTY 清理从未生效）；投影补上两字段后按原注释意图生效（两端同改）
- **第二行目录名尾字符被 mask 吃掉**：`.sub-text` 缺 `flex:1`，span 宽度贴着文本内容，尾部 16px 渐隐 mask 恒罩住最后一个字符；补上 flex:1 后与标题 `.t` 行为一致（短名完整显示，仅真正到边的长名渐隐）
- **平铺行间距**：相邻平铺行加 `margin-top: var(--space-05)`（2px，只作用于平铺列表，分组行保持贴死）
- **平铺翻页改为手动"展开更多"按钮**（2026-08-05 产品决策，取代滚动自动加载）：滚动到底自动翻页会在页面新增行少（与已加载池重叠高）时链式连发请求；先加了滚动意图门控、后按产品决策直接改为列表底部的「展开更多」按钮（复用组内 show-more 的行语言，点击才拉下一页，`flatLoadingMore` 时禁用并显示"加载中…"），`updateSessionsScrollState` 里的自动翻页逻辑整体移除。**一次点击会跨"零新增页"续翻**（有界 5 页）：整页与池中重叠或整页为空会话时游标前进但无新行，表现为"按钮没干活"——`loadMoreFlatSessions` 循环翻页直到有新增行或数据耗尽（真实数据里首页 100 条有 48 条空会话，该场景常见）；两端各 6 条单测钉住（`workspaceStateFlatPaging.test.ts`）。按钮样式后调整为：文案「加载更多」（新增 `sidebar.loadMore` key）、整行居中、chevron 图标挪到文字右侧、内容宽度悬浮 pill。**平铺视图加本地可见窗口**（2026-08-05）：平铺原来直接渲染整个共享池，首屏把分组模式预取的 ~90 条全显示出来（page size 改了也不体现）；现加 `flatVisibleCount` 窗口（初始一页），`flatSessions` = 池切片，点击窗口 +一页——本地池能覆盖就纯本地揭示，不够才拉下一页（`flatListHasMore` = 服务端有或窗口外还有本地数据）；`FLAT_SESSIONS_PAGE_SIZE` 提升为模块级导出常量。**平铺排序改为注意力优先**：有状态的会话（运行中 / 待授权 / 待回答 / 已中止 / 未读）浮到顶部，组内按 updatedAt 倒序，其余按 updatedAt 倒序；判定复用行级的 `sessionRowStatus`（hasStatus），状态消除即掉回时间序位置
- **第二行右侧显示关联 PR**（v2 git domain）：mock 支持 `include=git`，数据源用 v1 现成的 `fs:git_status`（已返回 `pullRequest`），按 cwd 去重 + 60s 缓存（模拟文档的服务端行为），失败/非 git 目录降级为 null；未知 include 报 `invalid_param`，include 计入游标指纹。PR chip（`git-pull-request` icon + #号）状态色按 GitHub 惯例：open `--color-success` 绿、merged `--color-done` 紫、closed faint 灰，点击 `window.open` 打开（不触发选中会话）；`upsertFlatSessionsPage` 会把 git 域 patch 到已在池中的会话上（v1 数据无此域，无"live 优先"冲突）
