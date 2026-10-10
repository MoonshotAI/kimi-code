# Tower 多 Agent 协作

Tower 是一种实验性的多 Agent 协调模式，适合在 Git 仓库中拆解并完成较大的编码目标。开启后，main agent 会成为 Tower：它把目标拆成多个 mission，协调实现与审查，并把通过审核的改动整合到你指定的 base branch（基准分支）。

每个 build mission（实现型任务）都有独立的 branch 和 git worktree（关联到同一仓库的独立工作区）。worker 在对应 worktree 中实现一个 mission 并提交；独立 reviewer 再以只读方式审查该 branch。Tower 负责传递消息与完成报告，只合并通过检查的分支。

因此，Tower 不只是普通 subagent，也不是 AgentSwarm 任务。它是一种由用户显式开启、在会话中持续协调的模式，带有明确的仓库状态、review 门槛和清理命令。

::: warning 注意
Tower 仍处于实验阶段，工作流程与安全细节可能变化。Tower 可以创建 branch、commit 和 worktree，worker 和 reviewer 会以 Never Ask 权限无人值守运行。请只在你信任的仓库中处理你信任的目标，并亲自检查最终 diff。
:::

## 适用与不适用场景

Tower 用更多 token 和仓库管理成本，换取并行实现与独立审查。

适合使用 Tower 的场景：

- 目标足够大，可以拆成相对独立、验证方式明确的 mission。
- 希望每项改动在独立 branch 上提交，经独立 review 后整合到本地基准分支。
- 可以让多个后台 Agent 持续运行，并在 Tower 报告决策或阻塞时介入。

通常不必使用 Tower 的场景：

- 快速修改、探索或单次问答，由 main agent 或 [普通 subagent](../customization/agents.md) 处理更经济。
- 工作高度耦合在同一批文件上，并行 branch 带来的整合成本高于并行收益。
- 不希望增加 branch、worktree、无人值守命令或多个 Agent 的 token 开销。

## 开启 Tower

Tower 默认关闭。选择下面一种方式启用实验功能，然后确认已重启 Kimi Code，再使用 `/tower`。

如需持久启用，在 `config.toml`（默认位于 `~/.kimi-code/config.toml`，详见 [配置文件](../configuration/config-files.md)）中加入：

```toml
[experimental]
tower = true
```

也可以打开 `/experiments`，启用 **Tower mode** 并应用修改；这会写入同一项配置。另一种方式是只在当前进程中启用，在启动前设置环境变量：

```sh
KIMI_CODE_EXPERIMENTAL_TOWER=1 kimi
```

环境变量必须在启动前设置。如果在 Kimi Code 运行期间修改 `/experiments` 或 `config.toml`，需要重启：Tower 的工具和 worker profile 会在进程启动时装配。只有启用实验功能后，`/tower` 命令才会出现。

开始之前，切换到希望接收合并结果的本地分支，并检查工作区：

```sh
cd /path/to/project
git status
```

Tower 合并到本地 branch，不接受 remote-tracking ref 或 tag。如果 `/tower <base-branch>` 指定的名称不存在，Tower 会从当前 checkout 创建对应的本地 branch。使用已有 branch 并保持 checkout 干净，是最可预期的方式。

::: warning 注意
未提交和未跟踪的文件可能会被快照进 worker branch；Tower 创建新的基准分支时，还可能把这些改动提交到该分支。在尚未初始化为 Git 仓库的目录中启用 Tower，也可能执行 `git init`，并创建包含现有文件的初始 commit。开始前请检查是否含有机密或大文件。
:::

## 从启动到合并

1. **开启 Tower 并选择 base。** 在 Kimi Code 中输入 `/tower feature/my-objective`。这会开启 Tower 并设定合并目标，**不会**发送任务目标。Tower 已开启时，同一形式会把工作区重新锚定到另一个本地 base，之后只有落后的未完成 mission 需要 rebase。使用 `/tower on` 可以在不改变已记录 base 的情况下开启 Tower；首次初始化时，默认采用当前本地 branch，detached HEAD（未检出任何 branch）则必须显式指定 base。

2. **把目标作为普通消息发送。** 例如，可以发送 "把结算文档更新拆成相互独立的 mission，分别测试，只合并通过独立 review 的 branch。" 同时写明所需验证和完成条件。Tower 会初始化 `.tower/`、规划 mission，并在后台启动依赖已解除的 worker。worker 完成和 inbox 消息会唤醒 Tower，无需手动轮询。

3. **等待实现、审查和整合完成。** worker 会在各自的 mission branch 上提交。Tower 会安排独立 reviewer，在需要时 rebase，并按依赖顺序合并通过审核的 mission。请处理当前权限模式给出的审批提示，并回答范围或优先级方面的问题。

4. **验证整合结果。** 检查 `git status`、基准分支历史和最终 diff，并运行你关心的验收检查。Tower 的合并门槛是一道保护，不能替代你自己的验收判断。

5. **清理并退出。** 所有 mission 都已合并或放弃后，输入 `/tower teardown` 移除符合条件的 mission worktree，再输入 `/tower off` 退出 Tower 模式。这些操作的差异见 [停止、清理与重启](#停止清理与重启)。

## 查看状态并干预

无需亲自操作 worker 协议，也可以监督 Tower。

- **查看状态面板：** `/tower` 或 `/tower status` 会直接读取并渲染状态，不启动模型轮次。面板显示 base、mission、roster、review 门槛、inbox 数量、并发和近期活动。
- **调整协调方向：** Tower 开启期间直接发送普通消息。输入会 steer 到正在运行的协调轮次中，因此你可以补充约束、调整优先级或要求总结。Tower 把更新转给正在运行的 worker 后，worker 会在下一个步骤边界看到；当前工具调用不会被打断。
- **检查或停止 Agent：** 打开 `/tasks` 查看后台 Agent 的进展和输出，或明确停止其中一个。Tower 会把用户停止的 worker 或 reviewer 视为主动终止；除非你另有指示，否则不会恢复、重新分配或替换它。
- **切换 base：** 再次输入 `/tower <base-branch>`。现有未完成 mission 会按新 base 重新评估，只有落后的 branch 需要 rebase。合并前，主 checkout 必须位于记录的 base 上。

一个工作区只有一个 Tower 协调者。如果另一个忙碌的存活会话已经拥有它，其他会话将无法在这里开启 Tower；请回到拥有它的会话继续，或先关闭该会话。

## 理解合并与 rebase

worker 会被分配到各自的 worktree 中实现 mission，而不是在主 checkout 中工作。合并 build mission 前，Tower 会检查它已经完成、没有未完成任务或 blocker、worker 空闲、依赖已合并且 branch 已跟上 base。它还要求具备有效的 clean review 和 merge 批准（通常来自独立 reviewer），同时改动必须位于 mission 范围内、主 checkout 必须位于记录的 base，并且没有冲突的未提交文件。

base 前进后，Tower 可以在 worker 空闲且 worktree 干净时，把 mission branch 在该 worktree 中 rebase 到新 base。无冲突的 rebase 会保留原有 clean review 的绑定；发生冲突时 rebase 会中止，mission 交回 worker 解决。请以结构化结果为准，不要默认每次 rebase 或 merge 都已成功。

让 Tower 执行 Tower merge 和 rebase，不要自行运行临时的 Git 整合命令。不要手动编辑 `.tower/comms/` 下的文件：状态、通知和合并检查都依赖这些协议记录。你仍可以以只读方式检查 branch 和 worktree。

## 停止、清理与重启

这些操作的清理边界不同：

| 操作 | 作用 | 保留内容 |
| --- | --- | --- |
| `/tower off` | 退出当前会话的 Tower 模式。不会停止已在后台运行的 Agent，也不会清理文件；如有需要，先通过 `/tasks` 停止 Agent | `.tower/`、mission branch 和 worktree |
| `/tower teardown` | 要求 Agent 移除符合条件的 mission worktree 并报告结果。有未提交改动的 worktree 和仍有存活 Agent 的 worktree 会受到保护 | mission branch 和 `.tower/comms/` 审计记录；Tower 模式保持开启 |
| 退出 Kimi Code 或关闭会话 | 默认停止后台任务；如工作流程另有要求，可修改 [`background.keep_alive_on_exit`](../configuration/config-files.md#background) | 磁盘上的 `.tower/` 状态、branch 和 worktree |

重启后，尽可能恢复拥有 Tower 的会话。如果由另一个会话接管工作区，前一会话的 roster 条目会退役，但 mission 和 worktree 会保留；新的协调者必须重新派发 worker。避免同时用两个会话驱动同一工作区的 Tower。

Tower 还与 Goal、Plan 和 swarm 模式互斥。进入 Tower 会退出 Plan 或 swarm 模式，并暂停活跃的 goal。激活 goal 会退出 Tower，进入 Plan 或 swarm 模式也是如此。磁盘上的 Tower 状态会保留，之后可以用 `/tower on` 返回。

## 安全边界与资源开销

worktree 隔离用于协调写入，不是安全沙箱。worker 可以读取仓库内容，并以你的权限运行工具；Never Ask 模式不会为了审批而打断你。Tower worker 没有 `Agent` 工具，因此不能继续派发嵌套 subagent，但 mission 范围和合并检查仍只是协调保护，不应被当作信任边界。

每个 worker 和 reviewer 都有独立的模型上下文，也会独立消耗 token。协调者的规划、路由、恢复和合并轮次还会产生额外用量，因此更大的 Agent 队伍可能增加配额压力以及本地 CPU 和磁盘占用。Tower 会限制同时派发的 Agent 数量；`/tower status` 可以查看当前预算和运行中数量，且自身不会启动模型轮次。建议从少量相互独立的 mission 开始，并及时清理已完成的 worktree 以回收磁盘空间。

## 下一步

- [斜杠命令](../reference/slash-commands.md#模式与运行控制) — `/tower` 的准确命令形式与可用性
- [环境变量](../configuration/env-vars.md#运行时开关) — `KIMI_CODE_EXPERIMENTAL_TOWER` 及相关运行时开关
- [Agent 与 subagent](../customization/agents.md) — 更适合聚焦子任务的简单委派模式
