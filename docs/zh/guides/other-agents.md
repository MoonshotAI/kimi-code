# 在其他 Agent 中使用（Agent to Agent）

Kimi Code CLI 与桌面端内置了 **Kimi Agent Protocol (KAP)** 本地服务，让你可以在 Claude Code、Codex、Cursor 等其他 AI Agent 中直接与本机 Kimi Code 交互——在两个 Agent 之间双向交接会话、整理本机各工作区的历史会话，或组装 Agent Team 进行多轮方案讨论。

## 选择接入方式

| 你想做什么                | 协议和使用方式                              | 特点                                                                                                                          |
| -------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 执行一次性任务，如 benchmark 测试，仅需结果的任务派发等             | `kimi -p`，详见 [Kimi Code CLI](./print.md)| 执行一次性无交互任务，跑完即退出。                                                                                 |
| 在其他客户端中集成 Kimi Code，如 IDE、自己开发的客户端等  | ACP 协议，命令为 `kimi acp`，详见 [Kimi Code ACP](../reference/kimi-acp.md) | 接入 Zed、JetBrains 等支持 ACP 的编辑器，与当前窗口绑定并由编辑器执行文件与终端操作。                                                                        |
| 在其他 Agent 中协同开发或管理会话 | Kimi Agent 协议（本页教程）                  | 连接本机 Kimi Code 进行更复杂的会话交互，如双向交接任务、整理本机历史会话、进行 Agent-to-Agent 讨论等。|

## 前置准备

- **版本要求**：Kimi Code CLI >= v2.7.0；Kimi Code Desktop >= v1.4.0；
- **已完成登录或模型配置**：首次使用前请先完成登录（`kimi login`）或配置模型供应商，见[开始使用](./getting-started.md)。

## 使用场景

直接用自然语言告诉你的 Agent 想做什么即可。

可安装 `use-kimi-code` Skill：

使用命令行安装：

```sh
npx skills add https://code.kimi.com/kimi-code/skills/use-kimi-code.md -g
```

使用 Agent 安装：

> 请阅读 `https://code.kimi.com/kimi-code/skills/use-kimi-code.md` ，保存为本地 `use-kimi-code` skill。

### 示例场景一：对话交接 / HandOff

交接给 Kimi Code：

> 整理我们当前的目标、已改文件和下一步计划成一份 HandOff 文档，交接到本机 Kimi Code 新建会话继续推进，并且给我对应的 Session ID。

从 Kimi Code 接手：

> 读取本机 Kimi Code 中关于 `[某个主题或会话 ID]` 的会话，读取进度与卡点，理解后听我后续安排。

### 示例场景二：整理本机历史会话

> 帮我整理本机 Kimi Code 各工作区的历史会话，总结一份我最近做的事情，还有哪些没做完或者忘记了，并汇总还在进行中的工作。

### 示例场景三：协调 Agent Team 使用

以下只是简易示例，实际使用时可根据需求灵活组装。

> 把当前任务的后续三个方向创建成三个 session，我分别去跟进，或者我来跟你讨论后你分别安排他们工作。

## 相关文档

- [在脚本与 CI 中使用](./print.md) — 单次非交互执行与 `stream-json` 输出格式
- [在 IDE 中使用](./ides.md) — 通过 `kimi acp` 接入 Zed 与 JetBrains IDE
