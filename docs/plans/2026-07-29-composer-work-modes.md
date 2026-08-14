# Composer 主工作模式 pill（计划/目标 与 Swarm 解耦，删除模式菜单）

日期：2026-07-29 · 状态：交互流程定稿（实现依本文档）

## 背景与问题

Composer 工具栏的「模式菜单」（plan / goal / swarm 三行 popover）把两个不同维度混在一起：

- **计划（plan）、目标（goal）是主工作模式**——同一时刻至多启用一个（互斥），但菜单里它们表现得像可叠加的普通开关。
- **Swarm 是使用 agent 的方式**（正交开关），与主工作模式无关，不该出现在「模式」菜单里。

决定：删除模式菜单；主工作模式的显示融进 composer 输入区；启用只走 slash command。

## 原则

1. **计划 XOR 目标**：同一时刻至多一个主工作模式处于启用态。
2. **主工作模式 = composer 输入区左侧的一枚 pill**，可 × 关闭。
3. **启用只走 slash**（`/plan`、`/goal`）；退出只走 pill 的 ×。启用是 enable-only：已启用时再次输入同一裸命令不做事（不会把它当成开关关掉）。
4. **Swarm 解耦**：独立工具栏 chip + 既有启用确认，不再叫「模式」。

## 状态模型（沿用现有，无新增）

- `planMode`：会话级持久标志（session profile + per-prompt）。
- `goalMode`：一次性 armed 标志——发送文本时消费（创建目标后自动复位）。
- goal 实体（active/paused/blocked/complete）：agent 侧状态，由 dock workbar 的 goal pill + 面板承载（既有，不动）。
- `swarmMode`：会话级持久标志，与主工作模式正交。

## 交互流程

### 启用（slash）

| 输入 | 当前状态 | 结果 |
|---|---|---|
| `/plan`（裸，Enter） | plan 关 | plan 开：输入区左侧出现「计划」pill；命令文本被消费，不发消息 |
| `/plan`（裸） | plan 开 | 不做事（enable-only；退出只走 pill 的 ×） |
| `/plan`（裸） | goal armed | goal armed 解除 → plan 开（pill 互换） |
| `/plan`（裸） | goal active | 提示「目标进行中，暂不能启用计划模式」，不切换 |
| `/goal`（裸，Enter） | 无 goal、未 armed | goalMode armed：「目标」pill 出现，placeholder 切为「让智能体完成什么目标？」；命令文本被消费 |
| `/goal`（裸） | goal armed | 不做事（enable-only；解除只走 pill 的 ×） |
| `/goal`（裸） | goal active | 打开 goal 面板（focusGoal），不做 armed |
| `/goal <task>` | 任意 | 既有流程：创建目标（manual 权限弹确认） |
| `/goal pause/resume/cancel` | 任意 | 既有控制子命令，不变 |
| slash 菜单选 /goal、/plan | — | 作为裸命令直接消费（不填入文本），行为同上 |

### 显示

- pill 位置：input-row 内、textarea 左侧（inline leading chip）；无模式时不渲染，textarea 占满。
- 样式：中性灰底（`--color-surface`）小 pill + 图标 + 标签 + ×，浮于 textarea 第一行行首（text-indent 让位），与首行 baseline 对齐。
- 「计划」pill：计划图标 + `计划` + ×。
- 「目标」pill（armed）：target 图标 + `目标` + ×；同时 placeholder 切换。
- goal active 期间：composer pill 不显示——dock workbar 的 goal pill（目标 · 状态 + 点击开面板）已经承载，避免两处重复。

### 退出

- 「计划」pill × → plan 关。
- 「目标」(armed) pill × → 解除 armed，placeholder 复原。
- goal armed 下发送文本 → 创建目标 → armed 自动复位 → composer pill 消失，dock goal pill 出现（既有链路）。

### Swarm（解耦后）

- 独立工具栏 chip（左侧工具组，附件与 permission 之间）：sparkles 图标 + `Swarm`，开启时高亮，点击走既有 `toggleSwarmMode`（manual 权限的启用确认保留）。
- 不进输入区 pill，不与 plan/goal 互斥，不叫「模式」。
- `/swarm <task>` 单任务 swarm 行为不变。

## 互斥规则汇总

- 唯一互斥：composer 里同一时刻至多一个 armed pill——`/plan` 与 `/goal`（裸命令）自由互换，后启用者替换前者。
- 创建目标的原子写入顺带关计划（`goalObjective` 与 `planMode:false` 同一个 PATCH）。
- 此外一概不管：目标活跃中照样能 `/plan`；跨客户端造成的重叠也不防御，靠服务器同步自然纠正。

## 边界情况

- 草稿会话（无 session）：plan/armed 走 draftModes 暂存（既有机制），pill 同样显示。
- 切会话：pill 跟随会话级标志。
- goal 完成：composer 与 dock 都不再显示。
- 目标活跃中 `/plan`：不拦截——armed pill 照常挂上，发送时照常兑现（服务器只认 session profile，重叠由服务器同步纠正）。
- 模式写入失败 = 发送失败：清 optimistic 消息、复位 inFlight、pushOperationFailure，不区分哪一步失败、怎么失败。
- slash 判定：`/goal`、`/plan` 仅在整行精确匹配（去空格后）时作为模式命令；`/goal xxx` 走创建流程；正常文本不受影响。

## 实现面（删除 / 新增 / 改动）

- **删**：modes popover 全部（`modesRef` / `modesMenuRef` / `modesMenuStyle` / `modesOpen` / `toggleModes` / `closeModes` / `onModesDocClick` / `anyModeActive`、`mode-row` / `mode-tag` 模板与样式、`MODE_DESC_KEYS`）。
- **增**：input-row leading 工作模式 pill（`planOn` 与 goal-armed 二选一渲染）+ ×。
- **增**：工具栏独立 Swarm chip。
- **改**：`handleSubmit` slash 分支——裸 `/plan`、`/goal` 本地消费（改发 `togglePlan` / `toggleGoal` / `focusGoal`，不再走 `command` emit）。
- **i18n**：标签复用（`status.planLabel` / `status.goalLabel` / `status.swarmLabel` / `status.goalPlaceholder`）。
- **保留**：dock workbar goal pill + 面板、`createGoal` / `controlGoal` / `focusGoal` 通路、swarm 启用确认、`/swarm <task>`。

## 待定项（实现按默认取值，评审可改）

1. goal active 时 composer 不显示 pill（避免与 dock pill 重复）——备选：composer pill 常驻、× = 取消目标。
2. goal active 时 `/plan` 提示拦截——备选：允许并存（维持现状）或自动取消目标（带确认）。（2026-08-14 定稿：不拦截，见下节。）
3. Swarm chip 放左侧工具组——备选：放 permission 右侧。

## 简化定稿（2026-08-14）

实现阶段曾为此加了约 1700 行「守门 + 失败精确恢复」机器（串行化写入、未确认哨兵、开关序号追踪、跨会话草稿/附件恢复等），评审后判定过度复杂，全部拆除，回到上面的简单设计。标准与理由：

- 服务器只认 session profile；prompt 的 `plan_mode` 字段是死字段。armed 只是客户端本地意图，发送时才落实为 profile 写入。
- 失败一刀切：模式写入失败按发送失败统一处理（清 optimistic、复位 inFlight、pushOperationFailure），没有「可能写上了」的追踪，没有 rejected/uncertain 之外的新状态。
- 客户端不追求跨进程严丝合缝：唯一约束 = composer 同一时刻至多一个 armed pill；目标活跃中开 plan、跨客户端重叠等罕见竞态不防御，靠服务器同步自然纠正。
- 待定项 2 由此结案：目标活跃不拦截 `/plan`。
