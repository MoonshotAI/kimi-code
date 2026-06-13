# Web TODO 攻坚 · 逐 commit 汇报

> 分支 `feat/web`。每个任务一个 commit，下面按提交顺序记录前因后果。
> 本轮共 15 个代码 commit（从 `c8b16e8e` 之后），全程 `vue-tsc` 0 错、`oxlint` 0 error、单测从 75 增至 88 全绿。
>
> 验收补充（2026-06-13）：后续验收发现 P1-9 和 P2-12 还各有一个明显缺口，已 autosquash 追加进最终 commit `90b11087` 和 `76d12cf6`；因此本报告中这两项及其后的旧 hash 以 `reports/web-goal-fixes-acceptance.md` 为准。

## 总览（commit ↔ 任务）

| commit | 任务 | 一句话 |
|---|---|---|
| `c6a4f264` | P0-1 | ws 重连后流式恢复：投影器 offset 自愈，修永久只整段输出 |
| `4154fc0b` | P0-2 | 切模型失败回滚选择器，不再静默谎报成功 |
| `e9f3b246` | P0-3 | thinking 期间上滑不再被拽回底部（抑制窗口只留给平滑滚动） |
| `88ae65bb` | P0-4 | 会话 idle 后收尾残留 running 工具，修偶现转圈 |
| `176d3d87` | P1-5 | 手动中断：停止按钮和 Esc 反馈统一（中断本就已实现） |
| `9414ba4e` | P1-6 | tool call：去重命令 + 合并相邻卡片（向下展开本就有） |
| `28fd1b95` | P1-7 | 待办/后台任务面板重做：tab 不折叠、悬浮框可折叠、+N 修正、放大 |
| `a195dff7` | P1-8 | 审批和 AskUserQuestion 统一进底部 dock 同一槽位 |
| `f4a403be` | P1-9 | 文件 diff 不可用时不再弹会话级报错（降级 console.warn） |
| `980ff9d4` | P2-10 | 月亮在收到第一个 token 后消失 |
| `71f80cad` | P2-11 | markdown 表格去掉 hover 行高亮 |
| `4d228683` | P2-12 | 输入框打 / 列出会话 skills 并激活 |
| `a44584d2` | P2-13 | Add workspace 子目录实时过滤（新建对话选 workspace 本就具备） |
| `05f83b0f` | P2-14 | 排查日志导出补前端报错捕获（一键导出本就具备） |
| `97430327` | P2-15 | 验证 Steer + 图片配合（通过，补回归测试） |
| — | P0-0 | 验证 Onboarding 切模型已被 `a9ac723d` 修复，无需改动 |
| — | P3-16 / P3-17 | Terminal+分屏、/goal /swarm /subagent：后端调研 + 落地设计简报（见文末，按用户意愿留作单独设计轮） |

---

## P0-1 · 修复 ws 断线后流式恢复失效

**现象**：WebSocket 断开过一次后，正在跑的会话就无法继续流式显示了——每段输出要等整段完成才一次性出现，切换 session 也没用，必须整页刷新才恢复。这是四个 P0 里最重的。

**排查过程**：先怀疑是服务端重连后不再向新连接推送流式帧，逐层读了 `packages/server` 的 `wsBroadcastService`/`connection.ts`，确认重连后的新连接会重新订阅、加入会话广播集合，volatile（流式增量）和 durable（落盘可重放）两类帧走的是同一条 fan-out，不存在「只发 durable 不发 volatile」。再读协议层 `events.ts` 确认 `assistant.delta`/`thinking.delta`/`tool.progress` 等是 volatile：**不落盘、不重放**，重连客户端靠快照里的 `in_flight_turn` 恢复中途状态。

接着把焦点放到客户端投影器 `apps/kimi-web/src/api/daemon/agentEventProjector.ts`。它用每回合累积长度 `turnTextLen` 和 daemon 帧上的 `offset` 做对齐：`offset < 本地长度` 判为重复直接 **skip**，`offset > 本地长度` 判为缺口触发 **gap→resync**（拉快照重建）。写了一组重连复现单测后定位到真正的坑：**`turn.ended` 不重置 `turnTextLen`**。当断线重连时，durable 重放与实时 volatile 帧会在游标上竞态，导致下一回合的 `turn.started` 偶尔没送进投影器，而该回合的 delta（offset 从 0 起）却实时到了——此时 `offset(0) < 残留的 turnTextLen` 永远命中 **skip**。而 skip 路径是**静默且不可恢复**的（不像 gap 会触发 resync），于是流式永久卡死，只有刷新页面重建投影器才好。这与「断一次后只整段输出、切 session 没用、必须刷新」的表现完全吻合。

**改动**：在 `assistant.delta`/`thinking.delta` 里加了自愈——当 `offset === 0` 但本地累积 `> 0`，说明 daemon 开了一条全新的流（漏掉了 `turn.started`），把本地计数清零再对齐，让流式接着走而不是永久跳过；同时在 `turn.ended` 顺手把两个计数清零，防止上一回合的残留长度污染下一回合。新增 `test/reconnect-streaming.test.ts` 覆盖正常流式、重连后新回合、回合内 gap→resync、以及「漏掉 turn.started」这条会失败的回归用例。全量 75 个单测通过。

---

## P0-2 · 修复断线时切模型静默失败

**现象**：WebSocket 断开时切换模型没有任何提示，用户以为切成功了。和 P0-1 同属「断线后状态没恢复好」一类。

**排查过程**：模型切换走的是 `setModel`（`useKimiWebClient.ts`）→ HTTP `POST /sessions/{id}/profile`，**不经过 WS**。所以单纯 ws 断开并不会让切换失败；真正失败的是 daemon 整体不可达时 HTTP 请求抛错。原代码是乐观更新：先把 UI 立刻切到新模型，失败时只 `pushWarning` 弹一个容易被忽略的提示，但**选择器不回滚**——于是用户看到的还是「新模型已选中」，加上 toast 一闪而过，体感就是「静默成功了」。

**改动**：在 `setModel` 里先记下原模型 `prevModel`，请求失败时把会话模型回滚成原值，让 UI 不再谎报成功，再走原有的失败提示；成功后的 `refreshSessionStatus` 改为「失败也不回滚」（它只是读权威模型，读不到不代表切换没生效）。新增 `test/set-model-rollback.test.ts` 覆盖失败回滚+告警、成功保留两种路径。全量 77 个单测通过。

---

## P0-3 · 修复 thinking 输出期间被拉回最新消息

**现象**：thinking/流式输出期间，往上滚查看老上下文会被强行拽回底部。

**排查过程**：跟随逻辑在 `ConversationPane.vue` 的 `following` 意图状态机里。正常情况下用户上滑（`top < lastScrollTop-1 && dist>1`）会立刻把 `following` 置 false，停止跟随。但 `onPanesScroll` 开头有一段抑制：**程序化滚动后 100ms 内的所有 scroll 事件都被当成非用户操作直接吞掉**（只同步 `lastScrollTop` 就 return）。这段是为「平滑滚动 `scrollTo({behavior:'smooth'})` 会异步补发一串 scroll 事件、可能被误判为上滑」准备的。问题在于 thinking 阶段内容高频变化（含每 ~120ms 重渲染的月亮 spinner），流式跟随几乎每 120ms 就程序化 `scrollToBottom` 一次，于是用户的上滑 scroll 事件极大概率正好落在某次程序化滚动后的 100ms 窗口内被吞掉 → `following` 永远翻不成 false → 被反复拽回底部。

**改动**：关键观察是流式跟随走的是**同步** `el.scrollTop = el.scrollHeight`，赋值后当场把 `lastScrollTop` 同步成底部，根本不需要抑制窗口——它异步补发的 echo 事件 `top === lastScrollTop` 天然是 no-op。只有平滑滚动（仅「新消息」pill 点击用）才会异步多次补发。于是把抑制窗口的时间戳从「任何程序化滚动」收窄为「仅平滑滚动」（`lastProgrammaticScroll` → `lastSmoothScroll`，只在 smooth 分支记录）。这样 thinking 期间的上滑不再被吞，pill 的平滑滚动行为保持不变。这类 DOM 滚动时序逻辑在本仓库没有现成测试基建，单独搭组件挂载+rAF 队列测试成本过高，故以逻辑推导+全量回归（77 个单测通过）验证。

---

## P0-4 · 修复读完文件后 toolcall 偶现一直转圈

**现象**：偶现读完文件后 toolcall 一直转圈圈（spinner 不停），不影响使用但观感差。

**排查过程**：转圈条件就是 `ToolCall.vue` 里 `tool.status === 'running'`。状态来自 `messagesToTurns`：`toolUse` 默认 `running`，直到同 `toolCallId` 的 `toolResult` 折进来才变 ok/error。`flushGroup` 在非 final 的 group 里会把残留 running 工具收尾成 ok，但**最后一个 group 故意保留 running**，给实时 in-flight 工具显示 spinner。问题就在这：当某个 `tool.result` 帧因重连/事件乱序被投影器丢了（和 P0-1 同源的时序问题），这个工具在回合早已结束、会话已经 idle 之后，仍然停在 final group 里永久转圈。「偶现」正是这种竞态——大多数时候 result 正常折入，个别时候丢帧。

**改动**：与其去抓那个难复现的具体丢帧竞态，采用更稳的兜底——给 `messagesToTurns` 增加 `sessionActive` 参数：只有**会话仍在活跃**（running / 等待审批 / 等待提问）时，final group 才保留 spinner；一旦会话 idle，final group 里的残留 running 工具也收尾成 ok。`useKimiWebClient` 的 `turns` computed 传入 `activity.value !== 'idle'`。这样实时回合的 spinner 保持原样，回合结束后绝不空转。新增 `test/dangling-tool-spinner.test.ts` 覆盖：active 保留 running、idle 收尾成 ok、有 result 时照常 ok。全量 80 个单测通过。

---

## P0-0 · 验证「Onboarding 切模型无反应」（无 commit，纯验证）

结论：**已被提交 `a9ac723d` 修复，当前 HEAD 仍有效，本轮无需改动**。该提交把 onboarding/新会话草稿态下的模型选择记进 `draftModel`：状态栏 `status` computed 立即反映草稿选择（`useKimiWebClient.ts:1172`），首条 prompt 经 `startSessionAndSendPrompt` 把它传给 `createSession`（`:1697-1701`），并对 daemon 回显 model 为 `''` 的情况做了保护。已有测试 `test/start-session-and-send.test.ts` 的 `applies a model picked in the draft state` 守护这条路径（7 个测试通过）。故此条直接划掉。

---

## P1-5 · 手动中断 agent（补齐反馈一致性）

**现状核查**：手动中断其实**已经实现并接通**：运行时 Composer 的发送按钮会变成停止方块，点击 emit `interrupt`；ConversationPane 监听 document 的 Escape，运行/发送中按下也会 `interrupt`；App.vue `@interrupt="client.abortCurrentPrompt()"` 调到 `abortPrompt` REST。移动端复用同一组件，靠停止按钮覆盖（无物理 Esc）。

**发现的小缺口**：只有 Escape 路径会弹「已中断」toast（`showAbortToast` 写在 `onKeyDown` 里），**点停止按钮中断是静默的**，两条路径反馈不一致。

**改动**：抽出单一入口 `handleInterrupt()`（弹 toast + emit），Escape 和 Composer 的停止按钮都走它，反馈统一。`vue-tsc --noEmit` 通过。这是已实现功能的一处一致性补齐，核心中断能力本就具备。

---

## P2-10 · 月亮在收到第一个 token 后消失

**现象**：发送后的「月亮」加载占位应在收到第一个 token 后就消失，但它一直挂到整段输出结束。

**排查过程**：月亮占位 `ChatPane.vue` 由 `sending` prop 控制（注释写明语义是「已发送、回复尚未开始流式」）。但 `sendingBySession[sid]` 只在回合结束（`onSessionIdle`）或出错时才置 false——于是回复都在流式了，月亮还挂在转录末尾陪跑一整回合。

**改动**：在 WS `onEvent` 里，一旦收到该会话的第一个流式产出——`assistantDelta`（thinking/text token）或 `messageUpdated`（回合一上来就发工具调用的情况）——立即把 `sendingBySession[sid]` 置 false，让月亮把位置交给实时流。新增 `test/sending-moon.test.ts` 断言发送后 `isSending` 为 true、收到首个 `assistantDelta` 后变 false。全量 81 个单测通过。

---

## P2-11 · 表格去掉 hover

**现象**：Markdown 表格鼠标悬停有行高亮，只读表格上是噪音。

**排查过程**：本来就有一处覆盖（`Markdown.vue`），但写成了 `.md :deep(table-node) tbody tr:hover`——用的是 `table-node` **元素**选择器，而 markstream-vue 实际用的是 `.table-node` **类**，其规则是组件 scope 的 `.table-node[data-v-39f87b5d] tbody tr:hover{background-color:var(--code-action-hover-bg)}`（特异性 0,3,2）。元素选择器根本没匹配上，所以 hover 一直在。

**改动**：覆盖规则改成匹配类名 `.md :deep(.table-node) tbody tr:hover`，背景设 `transparent !important`，稳过 scope 样式注入顺序。`vue-tsc` 通过。

---

## P1-6 · Tool call 渲染重构（三合一）

原始三条合并处理：①向下展开 ②展开后命令只显示一遍 ③合并相邻 toolcall。

**① 向下展开**：核查现状——`ToolCall.vue` 的展开体 `.bb` 渲染在 header `.bh` 之后，caret 闭合时指向右（›）、展开时指向下（v），本就是向下展开。无需改动。

**② 命令只显示一遍**：展开一个工具卡时，命令/摘要 `summary()` 会出现两次——header 的 `.p` 详情行 + 展开体顶部的 `.bb-summary`。后者原是给触屏（无 `:title` tooltip）补全文用的，但桌面就是重复。按用户「二选一」去掉展开体里的 `.bb-summary`（连同其 CSS），只保留 header 那一份，展开体只显示输出。

**③ 合并相邻 toolcall**：连续的 ToolCall 各渲染成一个 `.box` 兄弟元素，原来是 N 个带间距的独立卡片。用纯 CSS 相邻选择器把背靠背的工具卡合并成一个连续面板：`.box:has(+ .box)` 去掉下外边距+下圆角，`.box + .box` 上外边距 -1px 合并边框+去上圆角。中间夹着 text/thinking 块会打断 DOM 相邻性，所以只有真正连续的工具调用才合并；media 卡片用的是 `.media-tool` 不是 `.box`，图片画廊不受影响。`vue-tsc` 通过，全量 81 个单测通过。

---

## P1-8 · 审批消息和 AskUserQuestion 统一

**现象/诉求**：审批卡片和 AskUserQuestion 卡片位置不一致——`QuestionCard` 钉在底部 dock 里、替换 Composer；`ApprovalCard` 渲染在转录流最底部、会随内容滚走。用户要「位置一样、样式融合成一套」。

**排查过程**：读两个组件发现它们已经共享同一套卡片外观（蓝色标题、`--soft` 头部底色、相同边框/圆角、同一批 CSS 变量），真正差异是**位置**和按钮行样式。两者本质都是「agent 阻塞等你决定」。

**改动**：把待审批也放进底部 dock 的同一个槽位（`ConversationPane`）：优先级 question > approval > composer，三者互斥。新增 `pendingApproval` computed 取第一条待审批，dock 里渲染 `ApprovalCard` 并直接 emit `approval`。给 docked 审批卡加 `.dock-approval`（`max-height:50vh; overflow-y:auto`）防止大 diff 把 dock 顶出屏幕，外边距与 question 卡对齐。同时把 `ChatPane` 里原来转录末尾的内联审批渲染、`approvalDecide` emit、`ApprovalCard` import 等死代码一并清掉，`ConversationPane` 对应的 `@approval-decide`/`handleApprovalDecide` 也移除。`vue-tsc`、oxlint（0 error）、81 个单测均通过。

> 说明：stub daemon 不易构造真实的 pending approval 事件，这条的浏览器实景联调建议接真 daemon 时补一次；改动本身是把同一组件在两个渲染槽位间迁移（props/事件不变），类型/测试/lint 均已过。

---

## P2-12 · 输入框打 / 的命令列表交互适配（接入会话 skills）

**现象/诉求**：在输入框打 `/` 只列出 17 个硬编码的内置命令，daemon 的会话级 skills（`GET /sessions/{id}/skills`）在 web 里根本够不到。原始 todo「主动触发 /skill 的适配」+ 采访澄清「用户在输入框打 /」指的就是这条。

**排查过程**：内置命令的 `/` 菜单本身是通的（打 `/` → `filterCommands` → 上下选 → Enter/Tab/点击 → emit `command` → App `handleCommand` 各有动作）。真正缺的是 skills：服务端已有 `GET /skills` 和 `POST /skills/{name}:activate`（`packages/server/src/routes/skills.ts`），web 客户端没接。

**改动（跨层但复用现有 emit）**：
- API：`client.ts` 加 `listSkills`/`activateSkill`，`types.ts` 加 `AppSkill` 和接口方法。
- composable：`skillsBySession` 按会话懒加载（`refreshSessionSidecars` 里触发），`skills` computed 暴露当前会话的 skills，`activateSkill(name, args?)` 动作。
- `slashCommands.ts`：`SlashCommand` 加 `isSkill` 标记；`buildSlashItems(skills)` 把 skills 以 `/<name>` 追加到内置命令后；`filterCommands` 接受可选 items。
- `Composer`：新增 `skills` prop，`/` 菜单用 `buildSlashItems(props.skills)`；选中仍走 `command` emit（`/skillname`）。`SlashMenu` 对 skill 渲染原始描述、对内置命令走 i18n。
- `App.handleCommand` 的 default 分支：把未命中内置命令的 `/<name> args` 当作 skill 激活（未知名走 daemon 的 skill.not_found，无害）。
- 串线：`App → ConversationPane → 两处 Composer` 传 `skills`。

新增 `test/slash-skills.test.ts` 覆盖合并/过滤/标记逻辑。`vue-tsc`、oxlint（0 error）、全量 86 个单测通过。

> 说明：stub daemon 无 `/skills` 路由，激活的实景联调建议接真 daemon 时补；纯逻辑层（合并+过滤）已单测覆盖，API 调用为标准 REST。

---

## P2-13 · Onboarding 新建对话选 workspace + Add workspace 过滤子目录

原始两条同页：①Onboarding session 页面直接新建对话、选 workspace ②Add workspace 支持过滤当前目录子目录。

**① 新建对话选 workspace（核查为已具备）**：`NewSessionDialog.vue` 已支持新建会话时填工作目录 cwd（`recentCwds` 快选 + 手输路径），配合侧栏的工作区切换器和空会话页的居中 Composer，「直接新建对话并选 workspace」这条路径本就通。无需改动，本轮不重复造。

**② Add workspace 过滤子目录（本条实质新增）**：`AddWorkspaceDialog` 浏览文件夹时是一条扁平长列表，子目录一多就只能滚。新增了一个实时过滤框（文件夹有内容时显示）：`filter` ref + `filteredEntries` computed（按名字大小写不敏感子串匹配），过滤框放在面包屑和列表之间；进入新文件夹时自动清空过滤；无匹配时给「没有匹配 q 的子文件夹」提示。新增 zh/en 两条 i18n（`filterPlaceholder`/`noFilterMatch`）。`vue-tsc`、oxlint（0 warning/error）通过。

---

## P2-14 · 排查日志一键导出

**现象/诉求**：页面出问题时能一键导出前端日志/请求记录（原 todo「console.log / export-log」）。

**排查过程**：仓库已有 KAP 调试面板（`debug/DebugPanel.vue` + `debug/trace.ts`，opt-in `?debug=1` 或 `localStorage["kimi-web.debug"]="1"`），已经能把 REST + WS 流量记进环形缓冲并通过「export jsonl」按钮一键下载（`trace.ts` 的 `traceToJsonl`）。所以「一键导出网络日志」本就具备。真正缺的是：**页面崩了往往是前端 JS 报错，网络日志看不到**。

**改动**：给 trace 增加 `client` 源——`installClientErrorCapture()`（`main.ts` 启动时调，opt-in、装一次、保留原行为不递归）把 `window.error`/`unhandledrejection` 和 `console.error`/`console.warn` 折进同一个缓冲；DebugPanel 加 `app errors` 过滤项和 `APP` badge。这样「export jsonl」导出的就是含前端报错的完整排查日志。新增测试断言 `console.error` 被折进 trace 且出现在导出里。`vue-tsc`、oxlint（0 error）、全量 87 个单测通过。

---

## P2-15 · 验证 Steer + 图片配合使用（验证 + 回归测试）

结论：**Steer + 图片本就能正常配合，未发现 bug**。逐层核查：`Composer.handleSteer` 的 payload 已含 `attachments`（和 submit 一致）；`useKimiWebClient.steerPrompt` 把队列+实时附件合并、构造含 `{type:'image', source:{kind:'file', fileId}}` 的 content、乐观回显带图、`submitPrompt` 把 text+image 一起发给 daemon 再 `steerPrompts`。

为这条「半小时验证项」补了一个回归测试（`test/steer.test.ts` 新增用例）：运行中带图 steer，断言①图片随 steered prompt 的 content 一起 submit ②乐观转录回显出现该图（`turn.images`）。全量 88 个单测通过。

---

## P1-7 · 待办 / 后台任务面板重做（四合一）

原始四条合并：①面板太小 UX 不好 ②角标计数不对（多任务也只显示 +1）③todo tab 进去还会折叠 ④后台任务悬浮框不能折叠。

**③ todo tab 还会折叠**：`TodoCard` 有 `inline`（tab 模式）和悬浮卡两种渲染，但折叠状态 `collapsed` 两种模式都生效——进了专属 `~/todo` tab 还能把整列折叠没了。改为：折叠只在悬浮卡模式可用（`canCollapse = !inline`），tab 模式 header 变成静态 `div`（无 chevron、不可点），列表恒展开。

**④ 后台任务悬浮框不能折叠**：`TasksCard` 整个 header 是「点击打开 tasks tab」，没有折叠能力。重构 header 为 `[打开 tab 按钮][折叠 chevron 按钮]` 两段：点标题/计数区打开 tab，点 chevron 折叠/展开列表，互不干扰。

**② 角标只显示 +1**：悬浮卡 `MAX_ROWS=4` 截断，第 5 个起塞进 `+N`——任务一多即便有空间也只露 4 行。把上限提到 12，并给列表加 `max-height:45vh + overflow-y:auto`，先尽量多展示、超了再滚动而非粗暴 `+N`。（注：TabBar 的任务角标本身是全量正确的，这条指的是悬浮卡。）

**① 太小**：悬浮 stack 宽度 260→300（加 `max-width` 防溢出），卡片字号 12→12.5px，header 点击区 padding 略增。

新增 zh/en 两条 i18n（`tasks.collapse`/`tasks.expand`）。`vue-tsc`、oxlint（0 warning/error）、全量 88 个单测通过。

---

## P1-9 · 文件 tab 收尾

用户说文件 tab「做得差不多了」，剩下测试 Changed/All 显示 + 修点击文件的「kimi server api 报错」。

**排查**：普通文件读取/列目录（`readFileContent`/`listDir`）本就吞错（返回 null/[]），不会冒报错。报错来源是点**改动文件**走的 `loadFileDiff`：它对任何失败都 `pushOperationFailure` 弹会话级警告。点一个 git 无法干净 diff 的改动文件（新增未跟踪/二进制/已删除），daemon 的 `fs:diff` 报错就会被弹成「kimi server api 报错」——和用户描述吻合。

**改动**：单个文件 diff 失败是**局部**问题不是会话级故障，而且 `DiffView` 在 diff 行为空时本就有优雅的「无 diff」空状态。于是把 `loadFileDiff` 的失败从全局 toast 降级为 `console.warn`（会被 P2-14 的 trace 捕获进导出日志），置空 diff 让面板显示「无 diff」。点改动文件不再冒吓人报错。`vue-tsc`、全量 88 个单测通过。

> 说明：Changed/All 两个视图的实景显示验证需要对真实项目跑（stub daemon 的 fs 是合成的，没有真实改动文件），建议接真 daemon/项目时过一遍；本轮聚焦修掉确定的报错路径。

---

## P3-16 · Terminal + 分屏（设计简报，未实现）

用户在采访里把 Terminal+分屏 和 /goal /swarm /subagent 都归为「到时候单独开一轮设计」的大功能。这两条我做了后端能力调研并给出可落地的设计简报，**不在本轮盲写实现**（盲写一个终端/分屏 UI 既无法在 stub 下验证，也会偏离尚未敲定的交互设计）。

**后端已就绪**：`packages/server/src/routes/terminals.ts` 提供 REST `POST/GET /sessions/{id}/terminals`、`GET .../terminals/{id}`、`:close`、`:resize`；WS 控制帧（`packages/protocol/src/ws-control.ts`）有 `terminal_attach` / `terminal_detach` / `terminal_input` / `terminal_resize` / `terminal_close`（客户端→服务端）和 `terminal_output` / `terminal_exit`（服务端→客户端）。即 pty 创建、附着、输入、resize、输出流、退出全都有。

**Web 需要做的**：
1. 终端渲染层：引入 xterm.js（新依赖），一个 `Terminal.vue` 包住 xterm 实例。
2. 数据通道：在 `DaemonEventSocket` 上加 `attach/detach/input/resize/close` 发送 + `terminal_output/terminal_exit` 接收，桥接到 xterm 的 `write()` 和 `onData`；client.ts 加终端 REST 方法。
3. 生命周期：创建终端 → attach → 流式 → resize（跟随容器尺寸，FitAddon）→ 关闭/exit 清理。
4. 分屏布局：在 ConversationPane 右侧或底部加一个可拖拽分隔的 pane（复用现有 `useResizable`），放终端；移动端降级为整屏切换。

**最小第一刀**：先不做分屏，在 `~/terminal` tab 里放单个终端（attach 到会话的默认 pty），把 xterm + WS 数据通道跑通；分屏作为第二步。**预估**：中等偏大，建议单独 PR。

---

## P3-17 · /goal、/swarm、/subagent 的 web 适配（设计简报，未实现）

**后端事件已就绪**（`packages/protocol/src/events.ts`）：`goal.updated`（带 `GoalSnapshot`/`GoalChange`）、`subagent.spawned/started/suspended/completed/failed`（带 `subagentId`/`subagentName`/`subagentType`/`swarmIndex`）、turn 上的 `swarmMode`。

**Web 现状**：投影器 `agentEventProjector.ts` 只把 `subagent.spawned/completed/failed` 映射成 `taskCreated/taskCompleted`（在任务面板里露个头），而 `goal.updated`、`subagent.started/suspended` 被显式丢弃，`swarmMode/swarmIndex` 没用上——没有 goal 进度 UI，也没有 swarm 分组。

**Web 需要做的（按优先级，建议逐个小 PR）**：
1. **/subagent（最先，雏形已有）**：补 `subagent.started/suspended` 的投影，让子代理有「spawned→started→(suspended)→completed/failed」完整生命周期；任务面板里把子代理和后台任务分区展示，带 `subagentName/subagentType`。
2. **/goal**：`goal.updated` 投影成一个 goal 状态（snapshot：目标文本 + 步骤/进度）；UI 上做一个常驻的「目标进度」卡（可复用 P1-7 重做后的悬浮 stack 或 dock 上方），随 `GoalChange` 增量更新。
3. **/swarm**：利用 `swarmMode`/`swarmIndex` 把同一波并行子代理按 swarm 分组渲染（一个 swarm = 一组并行 subagent 的看板），展示各分支状态。

**交互待定**：goal/swarm 卡片放哪（悬浮 / 专属 tab / dock）、是否可折叠、和现有 todo/tasks 面板如何并存——这些正是用户说要「单独开一轮设计」的部分，建议先就 #1 子代理生命周期落地（纯投影层、风险低、可单测），再就 goal/swarm 的展示位开一轮 brainstorming。
