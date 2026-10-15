# Tower 多 Agent 协作

Tower 是一种实验性多 Agent 协作模式。它把较大的开发任务拆成多个 mission（子任务），让 worker 在 Git 仓库中异步并行执行，减少逐个等待的时间。

启用后，main agent 会成为 Tower，负责协调这些 worker。worker 在后台运行时，用户可以随时查看进展、让 Tower 传话、调整方向或优先级，也可以停止某个 Agent。

Tower 还会安排独立 review 检查 worker 完成情况。每个 mission 都有独立的 branch 和 git worktree。worker 在各自的 worktree 中开发并提交，reviewer 以只读方式审查对应 branch。Tower 负责传递消息和完成报告，只有通过检查的 branch 才会合并。

因此 Tower 既不是普通的 subagent 调用，也不是 AgentSwarm 任务。它需要你显式开启，会在协作过程中保存仓库状态，并提供合并检查和清理命令。Tower 的优势在**及时响应**和**并行开发**。

::: warning 注意
仅 Tower 主控支持 Ask When Needed；worker 和 reviewer 会在 Never Ask 权限下自动运行，不会逐项请求审批。
:::

## 适用场景

是否使用 Tower，主要看任务能否并行，以及你是否接受更多的 token 消耗和磁盘占用。

一些合适的场景：

- 任务可以拆成多个相对独立、验证方式明确的 mission，并行推进能省去等待时间
- 需求仍在变化，需要频繁传达新要求、调整方向或优先级
- 希望每次修复都被仔细审核，有独立的 branch 和对应 review

## 开启 Tower

Tower 默认关闭，可以通过以下方式启用实验功能。

如需长期启用，在 `config.toml`（默认位于 `~/.kimi-code/config.toml`，详见 [配置文件](../configuration/config-files.md)）中加入：

```toml
[experimental]
tower = true
```

也可以在 `/experiments` 中启用 **Tower mode** 并应用修改，效果相同。若只想在当前进程中启用，可在启动前设置环境变量：

```sh
KIMI_CODE_EXPERIMENTAL_TOWER=1 kimi
```

环境变量必须在启动前设置。运行过程中修改 `/experiments` 或 `config.toml` 后，需要重启 Kimi Code，因为 Tower 的工具和 worker profile 只在进程启动时加载。启用实验功能后，`/tower` 才会出现在命令列表中。

开始之前，先切换到最终接收改动的本地 branch，并检查工作区状态：

```sh
cd /path/to/project
git status
```

Tower 的合并目标必须是本地 branch，不能是 remote-tracking ref 或 tag。如果 `/tower <base-branch>` 指定的 branch 不存在，Tower 会基于当前 checkout 创建它。使用已有 branch 并保持工作区干净，是最稳妥的做法。

::: warning 注意
Tower 可能把未提交和未跟踪的文件快照到 worker branch 中；创建新的基准分支时，也可能把这些改动提交到该分支。对于还不是 Git 仓库的目录，Tower 初始化时会执行 `git init`，并把现有文件纳入初始 commit。开始前请确认其中没有机密文件或超大文件。
:::

## 从启动到合并

1. **开启 Tower。** 通常直接输入 `/tower on` 即可。第一次初始化时，Tower 会把当前本地 branch 作为 base；以后开启时会沿用已记录的 base。这个命令只开启 Tower，不会发送任务目标。

   如果当前是 detached HEAD（未检出任何 branch），或者需要切换 base，再输入 `/tower <base-branch>`，例如 `/tower feature/my-objective`。

2. **发送开发目标。** 像平常对话一样输入任务，例如 "把结算文档更新拆成相互独立的 mission，分别测试，只合并通过独立 review 的 branch。" 最好同时说明如何验证、什么情况下算完成。Tower 会初始化 `.tower/`、规划 mission，并在后台启动依赖已经满足的 worker。worker 完成任务或 Tower 收到 inbox 消息时，Tower 就会自动继续处理，不用你反复查询。

3. **让任务在后台推进。** worker 会在各自的 branch 上提交改动。Tower 会安排独立 reviewer，必要时 rebase，并按依赖顺序合并通过审核的 mission。如果出现审批提示，或 Tower 询问任务范围和优先级，请及时处理。

4. **验收合并结果。** 检查 `git status`、base branch 的提交历史和最终 diff，并运行你关心的测试或验收命令。这些检查只能作为基础保障，不能替代人工验收。

5. **清理并退出。** 所有 mission 都已合并或放弃后，先输入 `/tower teardown` 清理可以移除的 mission worktree，再输入 `/tower off` 退出 Tower。不同操作的区别见 [停止、清理与重启](#停止清理与重启)。

## 查看状态并干预

你不需要了解 worker 间的通讯协议，也能查看和干预 Tower。

- **查看状态面板：** `/tower` 或 `/tower status` 会直接读取当前状态，不会触发新的模型请求。可以看到 base、mission、roster、合并检查、inbox 数量、并发情况和近期活动。
- **调整任务方向：** Tower 开启期间，直接发送普通消息即可补充约束、调整优先级或要求总结。Tower 把消息转给 worker 后，worker 会在下一步看到，不会打断当前工具调用。
- **检查或停止 Agent：** 打开 `/tasks` 查看后台 Agent 的进展和输出，必要时可以停止其中一个。对于你主动停止的 worker 或 reviewer，Tower 默认不会恢复、改派或替换；除非你另有指示。
- **切换 base：** 再次输入 `/tower <base-branch>`。Tower 会按新 base 重新检查现有 mission，只有落后的 branch 需要 rebase。合并前，主 checkout 必须位于记录的 base 上。

同一工作区只能有一个 Tower 主控。如果另一个会话已经在使用本项目的 Tower，当前会话就无法开启；请先关闭原会话中的 Tower。

## 合并与 rebase 规则

合并 mission 前，Tower 会确认 mission 已完成，并且 branch 已跟上 base。还需要有效的 clean review 和 merge 批准（通常来自独立 reviewer）。改动必须属于 mission 范围，主 checkout 必须位于记录的 base，且不能有与合并内容冲突的未提交改动。

base 更新后，如果 worker 空闲且 worktree 干净，Tower 可以在对应 worktree 中把 mission branch rebase 到新 base。无冲突时，原有 clean review 的绑定会保留；发生冲突时，rebase 会中止，并交回 worker 处理。

合并和 rebase 都交给 Tower 完成，不要另外手动执行 Git 整合命令。不要直接编辑 `.tower/comms/` 下的文件，状态、通知和合并检查都依赖这些记录。你可以只读查看 branch 和 worktree。

## 停止、清理与重启

这些操作的清理范围不同：

| 操作 | 作用 | 保留内容 |
| --- | --- | --- |
| `/tower off` | 退出当前会话的 Tower 模式，不停止已在后台运行的 Agent，也不清理文件 | `.tower/`、mission branch 和 worktree |
| `/tower teardown` | 让 Agent 移除符合条件的 mission worktree 并报告结果；有未提交改动或仍有 Agent 运行的 worktree 不会被删除 | mission branch 和 `.tower/comms/` 审计记录；Tower 模式保持开启 |
| 退出 Kimi Code 或关闭会话 | 停止 Tower worker 和 reviewer，之后需要重新派发 | 磁盘上的 `.tower/` 状态、branch 和 worktree |

kimi-code 重启后，如果改由另一个会话接管当前项目，原会话的 roster 条目会失效，但 mission 和 worktree 会保留；新的主控需要重新派发 worker。一个项目不能同时存在多个 Tower 主控。

## 模式互斥与 secondary model

Tower 与 Goal、Plan 和 swarm 模式互斥。进入 Tower 会退出 Plan 或 swarm，并暂停正在运行的 goal；启用 goal、Plan 或 swarm 也会退出 Tower。Tower 的状态会保留在磁盘上，之后可以用 `/tower on` 返回。

worker 和 reviewer 的模型选择规则不同。未配置 `[secondary_model]` 时，二者都使用 Tower 当前的主模型。配置后，新派生的 worker 使用 `default_model`，**reviewer 仍使用主模型**；但如果 `[secondary_model].force = true`，reviewer 也会改用 `default_model`。`TowerSpawn` 目前不支持为某个 mission 或某次派发单独选择模型。配置方式见 [subagent 模型池](../configuration/config-files.md#subagent-模型池)。

如果希望控制 token 开支，可以让 worker 使用成本较低的 secondary model。未设置 `force = true` 时，reviewer 将保持 primary model（主模型），以保留独立审查的预算。

## 安全边界与资源开销

worktree 只能隔离写入，不能当作安全沙箱。worker 可以读取仓库内容，并以你的权限运行工具；在 Never Ask 模式下，worker 和 reviewer 不会逐项向你请求审批。Tower worker 没有 `Agent` 工具，不能再派发 subagent。不过，mission 范围和合并检查只是流程约束，不是安全边界。

worker 和 reviewer 都有独立的模型上下文，也会分别消耗 token。Tower 的规划、消息路由、故障恢复和合并轮次还会产生额外消耗。Agent 越多，配额、CPU 和磁盘压力越大。Tower 会限制同时派发的 Agent 数量；`/tower status` 可以查看当前预算和运行数量，而且不会启动模型轮次。建议先拆少量相互独立的 mission，完成后及时清理 worktree，释放磁盘空间。

## 下一步

- [斜杠命令](../reference/slash-commands.md#模式与运行控制) — `/tower` 的各种用法
- [环境变量](../configuration/env-vars.md#运行时开关) — `KIMI_CODE_EXPERIMENTAL_TOWER` 及相关运行时开关
- [Agent 与 subagent](../customization/agents.md) — 适合聚焦子任务的简单委派方式
