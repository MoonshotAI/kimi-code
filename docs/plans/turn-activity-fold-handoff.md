# Handoff：回合折叠行（quiet 活动流的回合级折叠）

> 交给执行 agent 的实施计划。本文档自包含，不需要其他上下文。
> 交互定稿的高保真原型在 `docs/prototypes/collapse-cards/`（`index.html` 是评审首页，`v1-log-card.html` 是定稿方案，可用 `?collapsed` / `?open` / `?dark` / `?live` / `?freeze=N` / `?peek` 直达各状态）。原型是 HTML/JS，**只作视觉与行为参照，实现要按 Vue/现有组件体系重新落地**。

## 1. 背景与目标

main 现行（commit `f653b6b`）的消息流是「quiet activity stream」：工具调用是无框 quiet 行（`ToolDisclosure`），连续**同类**调用合并为 caption 组（`ToolGroup`），思考是默认折叠的 disclosure 行（`ThinkingBlock`）。问题：同类合并管不了思考块打断——一次 14 步的排查回合仍铺出 11 行，且没有回合级收拢，回看历史回合同样冗长。

**目标**：把连续的思考 + 工具调用折叠成一行 quiet disclosure（下称「折叠行」），正文（text 块）不参与折叠。

## 2. 设计定稿（全部已拍板，不要再开方案）

| 项 | 定稿 |
| --- | --- |
| 折叠粒度 | 回合间单层：**连续的 thinking + tool 块**收成一行；text 块打断即另起一行（text 永不折叠）。一个回合可能产生多个折叠行。 |
| 段长阈值 | 连续段 **≥ 2 步**才折叠；单步段保持现状渲染（单行 quiet 行信息量更高）。 |
| 折叠行内容 | **智能摘要句**：按工具类型聚合的自然语言时态句，复用 i18n `tools.group.typed.{kind}.done` 文案，按类型首现顺序排列。例：`读取了 2 个文件 · 搜索了 2 个模式 · 运行了 5 条命令（1 失败） · 思考了 5 次 · 26.8s`。 |
| 思考子句 | 保留「思考了 {n} 次」（默认项，评审可调），视觉上降一档（faint）。 |
| 失败语义 | 沿用现行组语汇：任一步失败 → 折叠行 glyph 红 ✕；同时句内按类型挂失败子句（`（1 失败）`，danger 色）。 |
| 耗时 | 回合活动总耗时收尾（faint）。 |
| 截断 | 一行省略号截断 + `title` tooltip 给全文（不做「等 N 次」归并）。 |
| 运行中指示 | 折叠行 glyph = **当前步骤对应工具的 icon 呼吸**（opacity 动画，同 `ToolGroup` 的 `.tg-kind.run`；思考=thinking 灯泡 icon）。**不用 StatusDot 蓝点**（已拍板弃用于折叠行；行内工具行的 StatusDot 保持现状不动）。 |
| 梯级/颜色 | quiet 色阶（muted 基色），**不靠颜色拉开层级**；chevron 常驻。 |
| 默认状态 | **进行中默认展开直播；全部落定后自动折回（失败也折回）；历史回合默认折叠。** 沿用现行组语汇：用户中途展开过也照折；settled→running（流式续上）时重新展开。 |
| 展开态 | 段内**平铺** quiet 行（思考行 + 工具行，原序），不做同类二级分组；行内详情（输出面板/匹配列表/思考全文）照常可展开。内容随页面滚动，不做内嵌滚动窗。 |
| hover 预览 | 折叠行停留 ~0.4s 浮出「最近 4 步」预览卡（原型 `?peek`）。**P2 可后置**：首版可只上线常驻 chevron，预览随后跟。 |
| 摘要风格 | 只有智能摘要句一种形态（原型里的「极简容器标题」对照已判死刑）。 |

### 参与/不参与折叠的块

- **参与**：thinking；quiet 行类工具（`bash / read / grep / search / glob / ls / web_fetch / edit / write` 及 `normalizeToolName` 可识别的同类）。编辑/写入行**参与**折叠（首版决策；§04 原本要求 edit 恒可见，这是有意的行为变更，摘要句会计数「编辑了 N 处」——若评审反弹再改为 edit 打断连续段）。
- **不参与（打断连续段，原样渲染）**：text；结果/交互型卡片——审批、提问、Todo、Goal、Swarm、子代理 identity 卡；成功媒体工具（`status==='ok' && media`，即现行 `rendersToolCard()===false` 的情况）；未识别类型的工具（与现行 GROUPABLE 的谨慎策略一致）。

## 3. 渲染模型改动

`apps/desktop/src/renderer/components/chatTurnRendering.ts` 的 `assistantRenderBlocks`：

- 新增块类型 `{ kind: 'activity-run', items: ActivityItem[] }`（`ActivityItem = thinking | tool`，带原 `sourceIndex`）。
- 收集规则：遍历 blocks，连续的可折叠块（见上）入 run；不可折叠块 flush。run 长度 ≥2 输出 `activity-run`，==1 按原样输出（thinking / tool）。
- 现行 `tool-stack`（同类组）逻辑**被 activity-run 取代**（展开态平铺，不再二级分组）；`ToolGroup` 组件在本功能上线后不再有渲染入口——保留组件文件不删（后续清理另议），但 `assistantRenderBlocks` 不再产出 `tool-stack`。注意同步更新 `apps/web/test/chat-turn-rendering.test.ts` 与 renderer 侧同目录测试。
- `renderBlockKey` 增加 activity-run 分支（用首个 item 的 sourceIndex）。

## 4. 摘要算法（`lib/activitySummary.ts`，新文件 + 单测）

```ts
summarizeActivity(items) => { clauses: string[], hasError: boolean, thinkingCount: number }
```

- 按 `normalizeToolName(tool.name)` 聚合计数与失败计数，类型按**首现顺序**排列。
- 每个类型一句：复用 i18n `tools.group.typed.{kind}.done`（「读取了 {count} 个文件」「运行了 {count} 条命令」……未知类型 fallback 到 `tools.group.countOther`）。
- 失败类型追加失败子句（新增 i18n key，zh `（{count} 失败）` / en ` ({count} failed)`），渲染时标 danger 色（需要一个结构化返回，UI 按片段上色，不要拼 HTML 字符串）。
- 末尾追加思考子句（新增 key，zh `思考了 {count} 次`）与总耗时（已有 `formatDuration`；faint 弱化）。
- 同时提供纯文本版（tooltip/title 用，不带片段标记）。
- **live 版**（进行中）：`summarizeLive(items, current)` → 当前动作（`正在{verb} {subject}`，subject=命令/文件名/模式，截断）+ 已完成类型的累计统计（`已读取 2 个文件`，同 i18n 时态模板换个连接前缀，新增 key）+ 计时。计时显示沿用 `ThinkingBlock` 的整秒语汇（`37s` / `1m37s`，1s 粒度，不要 0.1s）。
- 单测覆盖：类型聚合与顺序、失败子句定位、思考子句、纯文本版、未知类型 fallback、edit 计入、媒体/卡片类不在 items 内（由分组层保证）。

## 5. 组件（`components/chat/ActivityRun.vue`，新）

结构对齐原型与现行 `ToolGroup`/`ToolDisclosure` 语汇：

- 头部整行 `<button>`（aria-expanded）：glyph（settled=绿✓/红✕，running=当前工具 icon 呼吸）+ 摘要句（muted；失败子句 danger；思考/耗时 faint；一行截断 + title）+ 常驻 chevron（旋转 90°）。
- 展开体：现行 `grid-template-rows 0fr↔1fr` 动画，内部按序渲染 `ThinkingBlock` 与 `ToolCall`（复用现有组件，不改它们）。`ThinkingBlock` 的「流走即折」与 `ToolCall` 的 pinScroll 行为保持原样。
- 状态机（对齐原型 `v1-log-card.html` 的 `?live` 回放）：
  - `running`：展开；glyph=当前步骤 icon 呼吸；摘要=live 版（当前动作 + 累计统计 + 计时）。
  - `running → settled`：自动折回（含失败；无延迟特例，与 `ToolGroup` 的 settle watch 同构；原型为可读性用了 ~1s 延迟，实现按现行组一致立即折回，如需延迟 ≤800ms 可调）。
  - `settled → running`（同一段流式续上）：重新展开（现行 `ToolGroup` 同款 watch）。
  - 用户手动 toggle：展开/收起；settled 后不再有自动动作（历史回合保持用户状态）；进行中 toggle 后 settle 时仍自动折回（现行语汇）。
  - 折回时用 `inject('pinScroll')` 钉住头部（同 `ToolGroup`）。
- hover 预览（P2 可后置）：folded 且非 streaming 时，停留 400ms 浮出最近 4 项的迷你列表（quiet 行样式），移开即消；用现有 popover/Tooltip 体系实现，展开或 streaming 时不显示。
- 新行进场用全局 `kimi-card-in`；`prefers-reduced-motion` 下呼吸/进场全停（沿用现行规则）。
- `ChatPane.vue`：`assistantRenderBlocks` 模板分支接 `activity-run` → `ActivityRun.vue`，事件（openMedia/openFile/openAgent/openThinking）透传与现有一致。

## 6. i18n（`packages/web-i18n`，zh + en 同步加）

新增（建议放 `tools.activity` 命名空间）：
- `thinking`: zh `思考了 {count} 次` / en `Thought {count} times`
- `failedClause`: zh `（{count} 失败）` / en ` ({count} failed)`
- `liveDonePrefix`: zh `已` / en ``（或按句法调整，如 `read {count} files` 复用 done 模板）
- `liveThinking`: zh `正在思考…` / en `Thinking…`（若现有 `thinking.streaming` 可复用则不新增）
- aria：`expand` / `collapse` 可复用 `tools.disclosure.*`。

## 7. 测试

- `lib/activitySummary.test.ts`（见 §4）。
- `chatTurnRendering` 分组测试：连续段成 run、text/卡片打断、单步段原样、媒体工具打断、key 稳定性。
- 根 `pnpm test`、`pnpm lint`、`pnpm typecheck` 全绿。

## 8. 验收清单（人工）

1. 流式回合：折叠行展开直播，glyph 随当前步骤换 icon 并呼吸，摘要实时更新（当前动作 + 累计统计 + 整秒计时）。
2. 全部落定（含中途有失败）：自动折回为一行摘要句；失败时 glyph 红 ✕ + 句内对应类型「（1 失败）」红字。
3. 历史回合：默认一行折叠行；点击展开为平铺 quiet 行；工具行/思考行内详情可再展开；chevron 旋转与 grid-rows 动画顺滑。
4. text 打断处自然分成多个折叠行；审批/提问/Todo/媒体块原样显示且不参与折叠。
5. 单步活动段保持现状渲染（不折叠）。
6. 深色模式、窄容器（mobile 宽度）、`prefers-reduced-motion` 各过一遍；键盘 Tab 可达、aria-expanded 正确。
7. 与原型 `v1-log-card.html?freeze=8` / `?collapsed&dark` 对照视觉。

## 9. 非目标（不要做）

- 段级/双层折叠（`v4`/`v5` 原型留档）、正文折叠、B 的节点串/轨道线。
- 行内工具行的 running StatusDot 改动；`ThinkingBlock`、`ToolDisclosure`、各 tool renderer 的样式改动。
- 「进行中默认折叠」设置项、折叠状态持久化、全局全部展开/收起（需要时另议）。
- hover 预览若做不进首版，留 TODO 注释即可，不要半成品。

## 10. 仓库规则（执行时遵守）

- 按 AGENTS.md：**先在 `apps/desktop` 开发并验证**，再同步 `apps/web`（共享文件两侧一致；先查 `apps/desktop/docs/native-todos.md`，保留 desktop 侧分叉块）。
- 不改 `kimi-code/` submodule；不擅自启动 agent-browser / `pnpm dev:desktop:debug`（人工验证由需求方做或经其同意）。
- 完成后必须走 `changeset` skill：`.changeset/` 只写 `kimi-code-app`，**patch**；Conventional Commits，无 AI 署名；stage 用显式路径，不用 `git add -A`。
