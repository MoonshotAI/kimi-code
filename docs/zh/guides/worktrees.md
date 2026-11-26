# Git worktree

Git worktree（Git 工作树，指同一个 Git 仓库额外检出的独立工作目录）让你在隔离目录里并行推进多个任务，不干扰主仓库中未提交的改动，也不必来回切换分支。

::: info 说明
Git worktree 目前处于 Beta 阶段，默认关闭。
:::

## 开启功能

可以通过以下任意一种方式开启：

- **在 TUI 中开启**：运行 `/lab`，打开 **Git worktrees**（或 **Enable all Beta features**）立即生效。
- **在配置中持久开启**：在 `~/.kimi-code/config.toml` 中添加：

```toml
[experimental]
worktree = true
```

- **单次启动开启**：启动时设置[环境变量](../configuration/env-vars.md#运行时开关)：

```sh
KIMI_CODE_EXPERIMENTAL_WORKTREE=1 kimi -w
```

## 在 TUI 中用 `/worktree` 管理

在本地 Git 仓库中运行 `/worktree`，可以查看、创建、切换和删除当前仓库的工作树。

## 在 CLI 中用 `kimi -w` 启动

在本地 Git 仓库中运行 `kimi -w`（或 `kimi --worktree`），Kimi Code CLI 会在 `$KIMI_CODE_HOME/worktrees/` 下新建一个独立工作树并直接进入工作。工作树存放在 Kimi 数据目录下，不会在项目仓库里留下未跟踪目录，无需修改 `.gitignore`。

```sh
# 从当前 HEAD 创建，自动生成名称（如 1202-kimi）
kimi -w

# 指定名称
kimi -w fix-auth

# 从指定分支、标签或提交创建
kimi -w fix-auth --worktree-base main
```

新工作树默认从 detached HEAD（分离头指针）检出，不占用现有分支，也不带入原目录未提交的改动。

`-w` 同样支持非交互式 [print 模式](../reference/kimi-command.md#print-模式)：

```sh
kimi -p "修复登录重试逻辑并运行测试" -w fix-auth
```

::: warning 注意
在 print 模式下使用 `-w` 需要先信任当前项目：先在该目录运行 `kimi` 确认信任，或设置 `KIMI_CODE_TRUST_WORKSPACE=1`。
:::

print 模式结束后会保留工作树，并在终端输出其路径，方便后续查看或清理。

## 复制忽略文件与初始化脚本

Git worktree 默认只包含已跟踪文件。需要带上被 `.gitignore` 忽略的本地文件或自动准备环境时，可在仓库中配置 `.worktreeinclude` 和 `.kimi-code/worktree-setup.sh`（两者均可提交到仓库与团队共享）。

### `.worktreeinclude`

在仓库根目录创建 `.worktreeinclude`，用 `.gitignore` 语法列出需要复制到新工作树的忽略文件：

```text
.env
.env.local
config/local.json
```

仅复制被 Git 忽略的文件，不会覆盖新工作树中已有的文件。

### `.kimi-code/worktree-setup.sh`

在仓库中放置 `.kimi-code/worktree-setup.sh`，可在新建工作树时自动准备环境（例如安装依赖）：

```sh
#!/bin/sh
set -e
pnpm install
```

该脚本仅在新建工作树后执行一次（切回已有工作树不会重复执行），优先读取新工作树中的版本，不存在时回退到源目录。运行时以新工作树根目录为工作目录，并提供两个环境变量：

- **`KIMI_CODE_WORKTREE_SOURCE_DIR`**：源目录根路径。
- **`KIMI_CODE_WORKTREE_DIR`**：新工作树根路径。

TUI 中每次新建都会询问是否运行；print 模式在项目受信任后自动运行。

## 退出时的清理

从托管工作树退出 TUI 时，如果该工作树未被其他窗口使用，会弹出确认面板（默认保留），由你决定保留还是删除。

## 下一步

- [会话与上下文](./sessions.md) — 恢复与管理会话
- [kimi 命令](../reference/kimi-command.md) — 查看完整启动参数
- [数据路径](../configuration/data-locations.md) — 查看托管工作树的存储位置
