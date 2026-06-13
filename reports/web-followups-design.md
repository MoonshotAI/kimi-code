# Web 后续：P1-9 方案对比 + P3 详细设计

> 一份汇总三件事的结论文档：
> 1. **P1-9 文件 tab** —— 我本轮的客户端修法 vs 你 stash 里的根因修法，对比 + 推荐。
> 2. **P3-16 Terminal + 分屏** —— 详细设计方案。
> 3. **P3-17 /goal、/swarm、/subagent 的 web 适配** —— 详细设计方案。
>
> 验收补充（2026-06-13）：本文件第一部分提到的 `stash@{0}` 根因修法已经合入最终 commit `90b11087`，不再是待办建议；P3 两节仍只是设计简报，未实现。

---

# 一、P1-9 文件 tab：两个方案对比

## 结论先说

**你 stash@{0} 的方案是对的，应该用它；我本轮提交的 `f4a403be` 是治标，且作用在一个其实被隐藏的 tab 上。** 建议：恢复并合入你的 stash，然后把我那条 commit revert 或保留为「兜底」（见下）。

## 两个方案做了什么

| 维度 | 我的 `f4a403be`（已提交） | 你的 stash@{0}（未提交） |
|---|---|---|
| 层次 | 仅前端 1 处 | 协议→服务端→服务实现→前端→stub→测试，端到端 |
| files tab 可见性 | **没动**——它在 `TabBar.vue` 里被 `// TODO: temporarily hide` 注释掉了，根本没显示 | **重新启用** files tab（去掉 TODO 注释 + 恢复 changes 红点） |
| 报错根因 | 没处理；只是把 `loadFileDiff` 失败的全局 toast 降级成 `console.warn` | 处理了：①非 git 工作区不再走 Changed/diff ②新增真正的 `fs:diff` 端点让 diff 真的能用 |
| 非 git 工作区 | 未处理（仍会走 Changed 视图→git 调用报错） | `gitInfo===null` 时隐藏 Changed\|All 开关、直接显示整棵文件树（`filesView` computed） |
| `fs:diff` 端点 | 不存在（前端调一个后端没有的接口 → 必然报错） | **新增**：`packages/protocol/src/rest/fs.ts` schema + `server/src/routes/fs.ts` 的 `handleDiff` + `services/fsGitService.ts` 的 `diff()` 实现 |
| diff 实现覆盖 | — | modified / 未跟踪(对 /dev/null) / 已删除 / 无 commit 仓库 / clean(空 diff)，含 `DIFF_MAX_BYTES=1MiB` 截断 + `truncated` |
| 错误码 | — | 40908 非 git 仓库 / 40409 文件不存在 / 41304 路径越界 / 40001 校验 / 40401 未知会话 |
| API 收紧 | — | `getFileDiff(path)` 参数从可选改必填 |
| stub 支持 | — | stub-daemon 加假 `fs:diff`，Changed→diff 流程可在本地演示 |
| 测试 | 无（仅靠 DiffView 既有空状态） | 服务端 e2e 8 例（覆盖所有 diff 形态 + 全部错误码）+ 前端挂载测试 `files-tab-no-git.test.ts`（非 git 隐藏开关、有 git 显示并默认 Changed） |

## 为什么你的方案是根因修复

「点击文件冒 kimi server api 报错」的真正原因有两层，我那版一层都没碰到：

1. **`fs:diff` 端点压根不存在**。前端 `getFileDiff` 在打一个后端没有实现的路由，任何点击改动文件都会拿到错误 envelope → 弹 toast。你的 stash 把这个端点从协议到服务实现整条补齐，diff 才真的能返回。
2. **非 git 工作区没有 Changed 概念**。`gitInfo===null` 时还硬走 Changed 视图，git 相关调用都会失败。你的 stash 用 `hasGit`/`filesView` 把非 git 工作区直接路由到「全部文件」树，连开关都不显示。

我那版只是把第 1 点失败后的 toast 静音，既没让 diff 能用，也没处理非 git 工作区，而且——files tab 当前是被注释隐藏的，用户实际根本点不到，我的「修复」无从触发。

## 落地建议

1. **采用 stash@{0}**：`git stash pop 'stash@{0}'`（注意它跨 web + 协议 + 服务端，pop 后要整体 review + 跑 `packages/server` 的 e2e）。
2. **我的 `f4a403be` 怎么办**：二选一——
   - **Revert**：你的 stash 让 diff 真的能用 + 非 git 不走 diff，正常路径不再报错，我那条多余 → revert 掉最干净。
   - **保留为兜底**：把 `loadFileDiff` 失败「不弹会话级 toast、降级 console.warn（进 trace 导出）」作为**真实错误**（如 40409 文件在点击后被删）的兜底也合理——但要确认不会掩盖应当告知用户的错误。我倾向 **revert**，让你的端到端方案作为唯一真相，需要兜底时再单独加。
3. **合并顺序**：先 stash（含服务端 e2e）→ 跑全量 → 再决定 revert/保留我的那条。

---

# 二、P3-16 Terminal + 分屏 · 详细设计

## 结论先说

后端已完整就绪（pty 的创建/附着/输入/resize/输出流/退出全有），web 侧是一个**纯前端 + 一个新依赖（xterm.js）**的活。建议**分两步**：先把「单个终端 tab」跑通，再做「分屏」。

## 后端契约（已存在，无需改后端）

**REST**（`packages/server/src/routes/terminals.ts`，`packages/protocol/src/rest/terminal.ts`）：

| 方法 | 路径 | body / 返回 |
|---|---|---|
| `POST` | `/sessions/{id}/terminals` | `{ cwd?, shell?, cols?, rows? }` → `Terminal { id, cwd, shell, cols, rows, ... }` |
| `GET` | `/sessions/{id}/terminals` | `{ items: Terminal[] }` |
| `GET` | `/sessions/{id}/terminals/{tid}` | `Terminal` |
| `POST` | `/sessions/{id}/terminals/{tid}:close` | 关闭 |

`cwd` 必须是相对会话工作区的相对路径。

**WS 控制帧**（`packages/protocol/src/ws-control.ts`）：

| 方向 | 帧 | 关键字段 |
|---|---|---|
| C→S | `terminal_attach` | `{ session_id, terminal_id, since_seq? }`，ack 回 `{ replayed }` |
| C→S | `terminal_detach` | `{ session_id, terminal_id }` |
| C→S | `terminal_input` | `{ session_id, terminal_id, data }` |
| C→S | `terminal_resize` | `{ session_id, terminal_id, cols, rows }` |
| C→S | `terminal_close` | `{ session_id, terminal_id }` |
| S→C | `terminal_output` | `{ seq, session_id, terminal_id, timestamp, payload:{ data } }` |
| S→C | `terminal_exit` | `{ session_id, terminal_id, payload:{ exit_code } }` |

注意：`terminal_output` 带 `seq` 且 attach 支持 `since_seq` + ack 的 `replayed`——即终端输出有**重放语义**，断线重连后可以从 `since_seq` 续，和会话事件流的游标机制一致。

## 架构

```
ConversationPane ── files/tasks/todo/[terminal] tab ──┐
                                                       │
            ┌───────────── Terminal.vue ──────────────┘
            │  封装 xterm.js Terminal + FitAddon
            │  - onData  → emit input
            │  - write() ← terminal_output.data
            │  - ResizeObserver → fit() → emit resize(cols,rows)
            │
            ▼
   useTerminal(sessionId) 组合式  ── REST: create/list/close
            │                     └ 维护 terminalId、attached、exitCode
            ▼
   DaemonEventSocket（扩展）  ── 发: attach/detach/input/resize/close
            │                  收: terminal_output(按 terminal_id 分发) / terminal_exit
            ▼
        daemon pty（已就绪）
```

## 前端要做的（按文件）

1. **依赖**：`@xterm/xterm` + `@xterm/addon-fit`（自包含，无远程资源）。
2. **`api/daemon/client.ts` + `types.ts`**：`createTerminal/listTerminals/getTerminal/closeTerminal` + `AppTerminal` 类型。
3. **`api/daemon/ws.ts`**：在 `DaemonEventSocket` 上加
   - 发送：`terminalAttach(sid,tid,sinceSeq?)` / `terminalInput(sid,tid,data)` / `terminalResize(...)` / `terminalDetach` / `terminalClose`；
   - 接收：在 `handleFrame` 里识别 `terminal_output` / `terminal_exit`，按 `terminal_id` 回调（新 handler `onTerminalOutput(tid,data,seq)` / `onTerminalExit(tid,exitCode)`）；
   - 重连：把每个 attached 终端的 `lastSeq` 记下，`onServerHello` 后用 `since_seq` 重新 attach（和现有会话订阅同构，能复用 P0-1 那套思路）。
4. **`composables/useTerminal.ts`**：create→attach→流式；`onData`→input；`fit`→resize；exit→标记结束、给重开按钮。
5. **`components/Terminal.vue`**：xterm 容器 + 主题（沿用 `--bg/--ink/--mono` 等 token 映射成 xterm theme）+ FitAddon + ResizeObserver。
6. **`ConversationPane.vue` + `TabBar.vue`**：加 `terminal` tab（`PaneKey` 扩一个枚举）。

## 分屏（第二步）

- 复用现有 `composables/useResizable.ts` + `components/ResizeHandle.vue`（stash@{2} 里也有 ResizeHandle 的改动可参考）。
- 桌面：会话主区右侧或底部劈一个可拖拽 pane 放 `Terminal.vue`；持久化分隔比例（localStorage，和现有 `kimi-web.*` 偏好一致）。
- 移动端：不分屏，`terminal` 作为独立 tab 整屏切换。
- 多终端：`listTerminals` 已支持多个 pty，分屏内可加一个极简终端切换条（后续增强，非首版）。

## 边界 & 注意

- **xterm 主题**：要把三套主题（terminal/modern/kimi）的颜色 token 映射成 xterm 的 `ITheme`，跟随 `useIsDark`/data-theme 切换。
- **后台标签页 rAF 冻结**（见项目记忆）：xterm 自身用 rAF 渲染，后台标签页可能卡渲染——attach 的 `since_seq` 重放能在切回前台时补齐输出，不会丢数据。
- **resize 抖动**：fit→resize 要防抖（~100ms），避免拖拽分隔条时狂发 `terminal_resize`。
- **退出态**：`terminal_exit` 后 xterm 置只读 + 显示 exit code + 「重开」按钮（create 新 pty）。

## 分阶段 & 测试

| 阶段 | 内容 | 验证 |
|---|---|---|
| 1 | client REST + ws 终端帧 + `useTerminal` | 单测：ws 帧编解码、output 按 tid 分发、重连用 since_seq 重 attach |
| 2 | `Terminal.vue` + `terminal` tab（单终端） | stub-daemon 加假 pty（回显输入）→ 浏览器实测输入/输出/resize/exit |
| 3 | 分屏布局 + 持久化比例 | 浏览器实测拖拽、移动端降级 |

**预估**：阶段 1+2 是一个中等 PR，阶段 3 一个小 PR。

---

# 三、P3-17 /goal、/swarm、/subagent 的 web 适配 · 详细设计

## 结论先说

后端事件很全，web 投影器目前只把 subagent 的 spawned/completed/failed 草草映射成「后台任务」，goal/swarm 完全没接。建议**按风险从低到高分三刀**：先补 subagent 生命周期（纯投影层、可单测）→ 再做 goal 进度卡 → 最后做 swarm 看板。goal/swarm 的**展示位**是采访里你要「单独设计轮」的点，下面给出选项 + 推荐。

## 后端契约（已存在）

**事件**（`packages/protocol/src/events.ts`）：

- `goal.updated` `{ snapshot: GoalSnapshot | null, change?: GoalChange }`
  - `GoalSnapshot { goalId, objective, completionCriterion?, status: 'active'|'paused'|'blocked'|'complete', turnsUsed, tokensUsed, wallClockMs, budget: GoalBudgetReport, terminalReason? }`
  - `GoalChange { kind: 'lifecycle'|'completion', status?, reason?, stats?, actor? }`
  - `GoalBudgetReport` 含各类预算上限/剩余/是否超支 —— 可直接做进度/预算条。
- `subagent.spawned { subagentId, subagentName, parentToolCallId, description?, swarmIndex?, runInBackground }`
- `subagent.started { subagentId }`
- `subagent.suspended { subagentId, reason }`
- `subagent.completed { subagentId, resultSummary, usage?, contextTokens? }`
- `subagent.failed { subagentId, error }`
- turn 上的 `swarmMode`，spawned 上的 `swarmIndex` —— swarm 分组依据。

## Web 现状（`api/daemon/agentEventProjector.ts`）

- `subagent.spawned/completed/failed` → `taskCreated/taskCompleted`（在任务面板露个头，但丢了 `subagentType`、`swarmIndex`、`description`）。
- `subagent.started` / `subagent.suspended` → **被丢弃**。
- `goal.updated` → 在「已知但不投影」列表里**被丢弃**。
- `swarmMode` / `swarmIndex` → 没用上。

## 第 1 刀：/subagent 生命周期（最先，风险最低）

**目标**：让子代理有完整「spawned→started→(suspended)→completed/failed」状态，并和普通后台任务在面板里分区。

- 投影层：`subagent.started`→把对应 task 状态置 running；`subagent.suspended`→置 suspended（带 reason）。spawned 时保留 `subagentName/subagentType/description`。
- 数据模型：`AppTask` 增加可选 `kind:'subagent'`（已有 kind 字段）+ `subagentType?`、`suspendedReason?`。
- UI：`TasksPane`/`TasksCard` 里把 `kind==='subagent'` 的分到「子代理」分组，普通的归「后台任务」（正好接上 P1-7 重做后的面板）。
- **可单测**：纯事件→AppEvent 投影，照 `reconnect-streaming.test.ts` 那样驱动 projector 断言即可，无需浏览器。

## 第 2 刀：/goal 进度卡

- 投影层：`goal.updated` → 新 AppEvent `goalUpdated`，reducer 维护 `goalBySession[sid]: GoalSnapshot | null`（complete/null 时清除）。
- 组件：`GoalCard.vue` —— 显示 `objective`、`status` 徽标、`turnsUsed/tokensUsed/wallClockMs`，以及基于 `GoalBudgetReport` 的预算条（剩余/超支高亮）。`GoalChange` 用来做增量高亮（如 status 变化时闪一下）。
- 展示位：见下「交互待定」。

## 第 3 刀：/swarm 看板

- 用 `swarmMode`（turn 级）+ `swarmIndex`（subagent 级）把同一波并行子代理聚成一个 swarm 组。
- 组件：`SwarmBoard.vue` —— 一个 swarm = 一组并行分支，每个分支显示 subagent 名 + 当前状态（spawned/started/suspended/done/failed）+ resultSummary 摘要。
- 复用第 1 刀的 subagent 状态机数据，只是换一种「按 swarmIndex 横向分组」的渲染。

## 交互待定（你要的「单独设计轮」就在这里）

goal 进度卡 / swarm 看板放哪，三个候选：

| 方案 | 优点 | 缺点 | 适合 |
|---|---|---|---|
| A. 复用 P1-7 的右上悬浮 stack | 和 todo/tasks 一致、不挤聊天 | 宽屏才有（<1200px 隐藏）、空间小 | goal 单卡 |
| B. 新增 `~/goal` / `~/swarm` 专属 tab | 空间大、能放看板 | 多一个 tab、要切换才看得到 | swarm 看板 |
| C. dock 上方常驻条（像 compaction 提示） | 常驻显眼、跟随聊天 | 占垂直空间、需可折叠 | goal 进度（活跃目标时） |

**推荐**：goal 用 **C（dock 上方可折叠常驻条）**，活跃目标时显示进度+预算，complete 后自动收起；swarm 用 **B（专属 tab）**，因为并行分支多、需要看板空间。subagent 分组并入现有 tasks 面板（第 1 刀已覆盖）。这套建议先把第 1 刀落地（纯投影、可单测、无交互争议），goal/swarm 的展示位再单开一轮 brainstorming 拍板。

## 分阶段 & 测试

| 阶段 | 内容 | 验证 |
|---|---|---|
| 1 | subagent 生命周期投影 + tasks 面板分组 | 单测：projector 断言（无需浏览器） |
| 2 | `goalUpdated` 投影 + `GoalCard` + dock 常驻条 | 单测投影 + 浏览器实测（stub 加 goal.updated） |
| 3 | swarm 分组 + `SwarmBoard` + `~/swarm` tab | 单测投影 + 浏览器实测 |

**预估**：阶段 1 一个小 PR（可立刻做），阶段 2、3 各一个中等 PR，且 2/3 前先开一轮交互设计。
