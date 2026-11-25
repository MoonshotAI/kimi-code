# Git worktree

Git worktree（Git 工作树，指同一个 Git 仓库额外检出的独立工作目录）让你在隔离目录里并行推进多个任务，不干扰主仓库中未提交的改动，也不必来回切换分支。

::: info 说明
Git worktree 目前是实验功能，默认关闭。
:::

## 开启功能

可以通过以下任意一种方式开启：

- **在 TUI 中开启**：运行 `/experiments`，打开 **Git worktrees** 并应用，立即生效，无需重启。
- **在配置中持久开启**：在 `~/.kimi-code/config.toml` 中添加：

```toml
[experimental]
worktree = true
```

- **单次启动开启**：启动前设置[环境变量](../configuration/env-vars.md#运行时开关)：

```sh
KIMI_CODE_EXPERIMENTAL_WORKTREE=1 kimi -w
```

## 在 TUI 中用 `/worktree` 管理

在本地 Git 仓库的 TUI 空闲状态下输入 `/worktree`，可以查看并管理当前仓库的工作树。直接输入或粘贴关键词即可过滤，按 `Enter` 切换进入，按 `Ctrl-N` 新建工作树，按 `Ctrl-X` 删除非当前工作树。

## 在 CLI 中用 `kimi -w` 启动

在任意本地 Git 仓库中运行 `kimi -w`（或 `kimi --worktree`），Kimi Code CLI 会在 `$KIMI_CODE_HOME/worktrees/` 下新建一个独立工作树并直接进入工作。由于工作树存放在 Kimi 数据目录下，不会在你的项目仓库里留下未跟踪目录，无需额外修改 `.gitignore`。

```sh
# 自动生成类似 1125-kimi 的随机名称，从当前 HEAD 创建
kimi -w

# 指定名称
kimi -w fix-auth

# 从指定分支、标签或提交创建
kimi -w fix-auth --worktree-base main
```

新建工作树默认处于 detached HEAD（分离头指针，不占用本地分支），源仓库中未提交的改动会留在原目录。如果你在仓库的子目录里运行 `kimi -w`，会话会自动进入新工作树中对应的子目录。

`-w` 同样支持非交互式 [print 模式](../reference/kimi-command.md#print-模式)：

```sh
kimi -p "修复登录重试逻辑并运行测试" -w fix-auth
```

::: warning 注意
在 print 模式下使用 `-w` 需要先信任当前项目，防止未信任仓库的 Git 钩子（如 `post-checkout`）在创建阶段执行。请先在该目录运行 `kimi` 并选择 "Trust and continue"，或在确认安全时设置 `KIMI_CODE_TRUST_WORKSPACE=1`。
:::

print 模式结束后不会自动删除工作树，会在 `stderr` 打印保留路径和提交状态，方便后续查看或清理。

## 复制忽略文件与初始化脚本

Git worktree 默认只包含已被 Git 跟踪的文件。如果新工作树需要带上被 `.gitignore` 忽略的本地文件，或需要自动安装依赖、准备环境，可以在仓库里配置 `.worktreeinclude` 或 `.kimi-code/worktree-setup.sh`。两者都可以提交到仓库与团队共享，`.worktreeinclude` 用于简单的文件复制场景，`.kimi-code/worktree-setup.sh` 用于执行自定义初始化命令。

### `.worktreeinclude`

在仓库根目录创建 `.worktreeinclude`，用 `.gitignore` 语法列出需要复制到新工作树的本地忽略文件：

```text
.env
.env.local
config/local.json
```

Kimi Code CLI 只复制被 Git 忽略的普通文件，不会覆盖新工作树中已有的文件。

### `.kimi-code/worktree-setup.sh`

在仓库中放置 `.kimi-code/worktree-setup.sh`，可在新建工作树后自动准备环境，例如安装依赖：

```sh
#!/bin/sh
set -e
pnpm install
```

该脚本只在新建工作树并复制完 `.worktreeinclude` 之后、进入会话之前执行一次，之后切回已有工作树不会重复跑。Kimi Code CLI 会优先执行新工作树里的脚本；如果新工作树中还没有该文件（例如脚本刚写好尚未提交，或基于旧提交创建工作树），则回退使用源目录里的脚本。运行时工作目录为新工作树根目录，并提供两个环境变量：

- **`KIMI_CODE_WORKTREE_SOURCE_DIR`**：源检出根目录。
- **`KIMI_CODE_WORKTREE_DIR`**：新工作树根目录。

在 TUI 中每次新建工作树都会询问是否运行或跳过；在 print 模式下，项目受信任后会自动运行。

## 退出时的清理

从 Kimi 托管工作树退出 TUI 时：

- **其他窗口正在使用**：直接保留并退出。
- **其他情况**：弹出确认面板（默认保留），展示未提交文件、独占提交和仍在运行的任务，由你选择保留或删除。选择删除时，会先关闭会话并停止所有运行中的轮次与后台任务，再删除目录。

## 下一步

- [会话与上下文](./sessions.md) — 了解 Git 仓库下 `/sessions` 的三标签页视图与同项目跨目录恢复
- [kimi 命令](../reference/kimi-command.md) — 查看 `-w`、`--worktree-base` 等完整参数参考
- [数据路径](../configuration/data-locations.md) — 查看托管工作树的存储目录
