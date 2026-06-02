# 开始使用

## Kimi Code CLI 是什么

Kimi Code CLI 是一个运行在终端中的 AI Agent，帮助你完成软件开发任务和日常的终端操作。它能阅读和编辑代码、执行 Shell 命令、搜索文件与抓取网页，并在执行过程中根据反馈自主规划和调整下一步行动。

它适用于以下场景：

- **编写和修改代码**：实现新功能、修复 bug、完成重构
- **理解项目**：探索陌生的代码库，解答架构和实现层面的问题
- **自动化任务**：批量处理文件、运行构建与测试、串联多个脚本

整套 CLI 以 TypeScript 编写，通过 npm 分发，运行在 Node.js 之上。

## 安装

### 脚本安装（推荐）

最快的安装方式是使用官方安装脚本，无需预装 Node.js：

- **macOS / Linux**：

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

- **Windows（PowerShell）**：

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

脚本会自动下载最新版本、校验 checksum，并把 `kimi` 可执行文件放到你的 `PATH` 中。

### npm 安装

如果你更习惯通过 npm 安装，需要 Node.js 24.15.0 或更高版本：

```sh
node --version
```

包名是 `@moonshot-ai/kimi-code`：

```sh
npm install -g @moonshot-ai/kimi-code
```

或用 pnpm：

```sh
pnpm add -g @moonshot-ai/kimi-code
```

## 系统依赖

除 Node.js 外，Kimi Code CLI 还会用到几个外部命令行工具。它们都不会阻塞启动——缺失时 CLI 会优雅降级并明确提示。你可以随时用 `/status` 查看它们的状态。

| 工具 | 用途 | 缺失时 |
| --- | --- | --- |
| `ripgrep`（`rg`） | `Grep` 工具与文件内容搜索 | 首次使用时自动下载。如果 `PATH` 中已有 `rg`，则优先使用系统版本。 |
| `fd` | `@` 提及的跨目录模糊文件搜索 | 可选。在 git 仓库内，`git ls-files` 仍可支撑 `@` 补全；在 git 仓库外则会给出启动警告。可通过 `brew install fd`（macOS）或 `sudo apt-get install fd-find`（Ubuntu）安装。 |
| Shell（Windows 上为 Git Bash） | `Bash` 工具，用于执行 shell 命令 | Windows 上 `Bash` 工具通过 Git Bash 运行。如果未安装且 `KIMI_SHELL_PATH` 未指向 `bash.exe`，CLI 仍会启动，但在 shell 可用前会省略 `Bash` 工具。安装 [Git for Windows](https://gitforwindows.org/) 即可启用。 |

## 升级与卸载

安装完成后，验证可执行文件是否就绪：

```sh
kimi --version
```

**升级**：运行 `kimi upgrade`，CLI 会检查最新版本并展示更新提示：

```sh
kimi upgrade
```

选择 `Install update now` 后，会根据当前检测到的安装来源执行升级；也可以继续使用当前版本。如果当前安装方式无法自动升级，该命令会打印需要手动执行的命令。你也可以直接使用包管理器升级。npm 安装的用户执行：

```sh
npm install -g @moonshot-ai/kimi-code@latest
```

**卸载**：脚本安装的用户删除 `kimi` 可执行文件即可；npm 安装的用户执行：

```sh
npm uninstall -g @moonshot-ai/kimi-code
```

## 第一次启动

进入你想要工作的项目目录，直接运行 `kimi` 启动交互界面：

```sh
cd your-project
kimi
```

如果只想执行一条指令而不进入交互界面，可以使用 `-p` 选项：

```sh
kimi -p "帮我看一下这个项目的目录结构"
```

如需继续上一次会话，添加 `-C` 选项即可：

```sh
kimi -C
```

首次启动时，Kimi Code CLI 尚未配置任何凭证，需要配置 API 来源才能开始对话。在交互界面中输入斜杠命令 `/login` 进入登录流程：

```
/login
```

`/login` 会弹出平台选择器，支持：

- **Kimi Code（OAuth）** — 验证码流程，在任意设备打开链接、登录并输入验证码即可授权
- **Kimi Platform API 密钥** — 输入来自 `platform.kimi.com` 或 `platform.kimi.ai` 的 API 密钥

需要退出登录时，输入 `/logout` 即可清除当前凭证。

::: tip 提示
如果你想使用 Anthropic、OpenAI、Google 等其他供应商，需要直接编辑 `config.toml` 配置 API 密钥，详见 [平台与模型](../configuration/providers.md)。模型、供应商等运行时配置也写入 `config.toml`。配置项说明见 [配置文件](../configuration/config-files.md)、[环境变量](../configuration/env-vars.md) 和 [配置覆盖](../configuration/overrides.md)。
:::

## 第一个对话

登录完成后，你就可以直接用自然语言向 Kimi Code CLI 描述任务。例如，让它先帮你熟悉一下当前项目：

```
帮我看一下这个项目的目录结构，简单介绍一下每个目录是做什么的
```

Kimi Code CLI 会自动调用文件读取、搜索和网页抓取工具，浏览相关内容之后再给出回答（读取文件、搜索网页等只读操作默认自动执行，无需确认）。对于会修改文件或执行 Shell 命令的操作，它默认会在执行前征求你的确认，你可以根据需要批准或拒绝。

也可以让它做一些更具体的事，比如：

```
在 src/utils 里新增一个函数，用来把任意字符串转成 kebab-case，并补一个单元测试
```

Kimi Code CLI 会规划步骤、修改代码、运行测试，并在每一步告诉你它做了什么。

在交互界面中，输入 `/help` 可以查看所有可用的 [斜杠命令](../reference/slash-commands.md)，以及常用的快捷键提示。如果想退出 Kimi Code CLI，可以输入 `/exit`；也可以按 `Ctrl-C`，界面会先清空输入框并提示再按一次，再次按下即退出；还可以在输入框为空时连按两次 `Ctrl-D` 退出。

## 数据存放在哪里

Kimi Code CLI 的本地数据默认保存在 `~/.kimi-code/` 目录下，包含配置文件、会话记录、日志和更新缓存等。如果你想改到别的位置，可以通过环境变量 `KIMI_CODE_HOME` 指定一个新的根目录。完整的目录结构和环境变量说明见 [数据路径](../configuration/data-locations.md) 和 [环境变量](../configuration/env-vars.md)。
