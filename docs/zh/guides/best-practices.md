# Kimi Code 最佳实践

> 涵盖从日常编码到批量自动化的使用技巧，帮你把 Kimi Code 用到极致。

Kimi Code 是一个自主编码环境。它不同于问答式 AI——它能读文件、跑命令、修改代码，并自主推进任务。理解这种自主性带来的模式，是用好它的关键。

## 1. 你没说的地方，Kimi 会自己决定

> 💡 Prompt 里没有约束的空间，是 Kimi 的判断空间。它会填满它——用它认为"更好"的东西。

这是使用 Kimi Code 最常见、最隐蔽的陷阱。

你对一段有 SQL 注入漏洞的代码说「帮我把这段代码改好」，Kimi 不只修了 SQL 注入：它同时加了类型注解、docstring、重构了折扣逻辑的实现方式、改了 order ID 格式，从 23 行变成 43 行。这些改动本身都合理，但：

- 你在做热修复，PR 里多出了一堆无关变更
- 改了 order ID 格式可能影响下游系统
- 类型注解在旧版本 Python 上会报错

问题不是 Kimi 做错了，而是你没有告诉它"什么不能动"。

**加约束，而不只是加目标**

同样的场景，加上约束后：

```
get_user_orders 有 SQL 注入风险，用参数化查询修掉。
只改这一个函数，不加类型注解，不加 docstring，不改任何其他逻辑。
```

结果：只有一行变了——SQL 那一句。其他一切保持不变。

| | Prompt | 实际改动 |
|---|---|---|
| ❌ | "帮我把这段代码改好" | SQL注入 + 类型注解 + docstring + 折扣逻辑重构 + order ID格式 + 异常处理 |
| ✅ | "修 get_user_orders 的 SQL 注入，不动其他" | 只改了1行 |

**什么时候该留空间，什么时候必须约束**

- **探索 / 技术债清理 / 不熟悉的代码库**：模糊 prompt 合理，让 Kimi 发现问题
- **热修复 / PR 里的定点修改 / 生产代码**：必须用约束，避免范围蔓延
- **迁移 / 格式化 / 批量变更**：模糊但要规定范围（"只处理 src/ 下的文件，不动 tests/"）

**写 prompt 的实用结构**

> **[目标文件/函数]** + **[要做什么]** + **[不能动什么]** + **[验收标准]**

```
# 示例
@src/auth/session.py 的 refresh_token 函数在 token 过期时没有抛出异常，
加上这个错误处理。只改这一个函数，不改调用方，不改测试文件。
改完跑 pytest tests/test_auth.py 确认通过。
```

## 2. 在代码落地之前拿到一个可以否决的方案

> 💡 Kimi 动手之前会读代码，但它做的架构选择你只能在代码写完之后才看到。Plan 模式在中间插入一个审批窗口——方案对了再执行，方案不对直接打回。

直接对一个 orders 系统说「加一个退款功能」，Kimi 会先读 `main.py`，看到 SQLite，然后——仍然引入了一个内存字典（`_orders_db = {}`）来存退款数据，还自己加了注释「生产环境应使用数据库」。

它知道这不理想，但还是这么做了：因为没有人告诉它「不行」。

等你看到这份代码，它已经写完了。而如果用了 Plan 模式，Kimi 会先写出方案「我打算用内存字典存退款记录」，你看到之后直接说「不行，必须用 SQLite，schema 在 orders 表里」，它再去实现。

**Plan 模式：先看方案，再执行**

Plan 模式下 Kimi 只读不写，把理解和方案呈给你审批，你批准后再执行。

进入方式：
- 启动时：`kimi --plan`
- 会话中：`Shift-Tab` 或 `/plan`

开启后提示符变为 `📋`，状态栏显示蓝色 `plan` 标识。Plan 模式的完整交互行为（含审批流程和 YOLO 模式的关系）见[交互与输入 → Plan 模式](../guides/interaction.md#plan-模式)。

**推荐工作流**

```
[Plan 模式] 读一下 @src/orders/ 下的代码，
理解现在的数据层是怎么设计的，用的什么存储方式。
```

Kimi 探索完后：

```
[Plan 模式] 我要加一个退款功能，支持全额和部分退款。
基于你刚才看到的代码结构，给我一个实施方案。
```

看方案、确认它选择了 SQLite 而不是内存字典、批准，然后退出 Plan 模式执行。

**什么情况值得 Plan，什么不值得**

- 新功能要集成到现有系统 → 必须先探索
- 跨多个文件或模块的改动 → 先 Plan
- 改一个变量名、加一行日志 → 直接做，不需要 Plan

计划是为避免方向错误付的低成本保险，但也有开销。能一句话描述清楚的改动不需要计划。

**动手前先打 checkpoint**

```bash
git commit -m "checkpoint: before refund feature"
```

出了问题，一条命令回到起点。

## 3. 记忆需要被设计

> 💡 每次新会话，Kimi 都是空白状态。它不记得上次你说过什么，也不知道你的项目有什么约定。把这些知识固化在文件里，让它越用越懂你的项目。

### 用 `/init` 生成 AGENTS.md

运行 `/init`，Kimi 会分析项目结构、构建系统、测试框架，生成 `AGENTS.md` 作为起点。每次会话开始时自动读取。（命令详情见[斜杠命令参考 → 账号与配置](../reference/slash-commands.md#账号与配置)）

格式不限，但要短。例如：

```markdown
# 构建与测试
- 用 pytest 跑测试：`pytest tests/ -v`
- 类型检查：`mypy src/`
- 数据层只用 SQLite，不引入 ORM

# 代码约定
- 不用 f-string 做 SQL 查询（必须用参数化查询）
- 不加 type annotation（项目还在 Python 3.8）
- 错误处理统一抛 ValueError，不用自定义异常类
```

**什么值得写，什么不用写**

| ✅ 应该写 | ❌ 不用写 |
|---|---|
| 构建和测试命令 | 读代码就能看出来的东西 |
| 技术选型约束（不用哪些库） | 标准的 Python/JS 惯例 |
| 与默认不同的代码风格 | 显而易见的规范（"写干净的代码"） |
| 非直觉的行为和已知的坑 | 逐文件描述代码库结构 |

每行都问自己：*"去掉这行，Kimi 会犯错吗？"* 不会的话，就删。文件太长，重要规则会被淹没。

**否定性规则比正向规则更稳定**

```markdown
# 不稳定（Kimi 可能"忘记"）
- 数据库操作用 SQLite

# 稳定（Kimi 更难绕开）
- 不用 SQLAlchemy，不用任何 ORM，只用原生 sqlite3 模块
```

否定性约束排除了具体的行为，比正向规则更难被忽略。

### 用 Skills 固化专业知识

Skills 是放在 `.claude/skills/` 下的知识文件，按需加载，不会在无关会话里占用上下文。

```markdown
# .claude/skills/db-conventions/SKILL.md
---
name: db-conventions
description: 项目数据库操作规范
---
# 数据库规范
- 只用 sqlite3 原生模块，不引入任何 ORM
- 所有 SQL 语句必须用参数化查询（cursor.execute("...", (param,))）
- 连接用 try/finally 确保关闭
- 不做 connection pool，每个函数自己开关连接
```

调用时：`/skill:db-conventions 帮我实现退款记录查询`

Skill 文件的完整格式、frontmatter 字段说明和多目录管理方式见 [Agent Skills](../customization/skills.md)。

### 用 `@` 引用，不要粘贴

```
帮我看一下 @src/auth/session.py 的 refresh_token 函数
```

Kimi 会在需要时读取文件，上下文里只有引用路径，不会被文件内容撑大。支持的引用类型（文件夹、glob 模式、URL 等）见[文件引用](../guides/interaction.md#文件引用)。

### 用图片补充上下文

除了文件引用，也可以直接把截图、设计稿、报错界面**粘贴进输入框**——Kimi 能理解图片内容并针对性地回应。例如粘贴一张 UI 截图说「这里的布局对不上设计稿」，或者粘贴一张终端报错截图。完整的图片和视频输入说明见[粘贴图片与视频](../guides/interaction.md#粘贴图片与视频)。

## 4. 工具链即杠杆

> 💡 开箱即用只是起点。Hooks 把规则从「建议」变成「保证」；MCP 打通外部系统；自定义 Agent 让脏活在隔离环境里跑。

### Hooks：不靠 Kimi 记得

Hooks 在 Kimi 工作流的特定节点自动触发脚本。和 AGENTS.md 里的文字指令不同，Hooks 是确定性执行的——不管 Kimi 有没有「记得」，动作必然发生。

最适合 Hooks 的场景：

- 每次编辑文件后自动跑 linter（「每次改完代码都跑 eslint」这类规则写在 AGENTS.md 里 Kimi 可能忘，Hook 不会）
- 禁止向某些目录写入（migrations/、secrets/ 等）
- 提交前自动跑类型检查

让 Kimi 帮你写：*「写一个 Hook，在每次文件编辑后跑 eslint --fix」*，它会生成配置并写入 `.claude/settings.json`。用 `/hooks` 查看当前配置的内容。Hook 事件类型、配置结构和返回值语义的完整说明见 [Hooks](../customization/hooks.md)。

### MCP：让 Kimi 直接用你的工具

MCP 让 Kimi 能与外部服务交互——查数据库、读 Notion 文档、看 Sentry 报错、拉 Figma 设计稿。配置方式见 [MCP](../customization/mcp.md)。

配置好后就可以直接说：

- "看一下 Sentry 里最近24小时的报错，定位频率最高的那个"
- "把 Linear 上 ENG-1234 这个 issue 的需求读一下，然后开始实现"
- "从数据库里查一下上周注册用户的留存率"

### 自定义 Agent：把专职任务隔离出去

在 `.claude/agents/` 下定义 Agent 文件，Kimi 可以把特定任务委派给这些专职助手。每个 Agent 在独立的上下文中运行，不占用主会话的 token。

```markdown
# .claude/agents/security-reviewer.md
---
name: security-reviewer
description: 审查代码中的安全漏洞
tools: Read, Grep, Glob, Bash
---
你是一位资深安全工程师。审查代码时重点关注：
- SQL 注入、XSS、命令注入等注入类漏洞
- 认证和授权缺陷
- 代码中的 secrets 或硬编码凭据
- 不安全的数据处理和序列化

给出具体的文件行号引用和修改建议。
```

用法：*「用 subagent 对 @src/orders/ 做安全审查」*

完整的 Agent 定义格式、上下文隔离机制和权限继承规则见 [Agent 与子 Agent](../customization/agents.md)。

## 5. 如何节省 Token

> 💡 Kimi 的上下文窗口是你最宝贵的资源。随着会话增长，性能会下降——Kimi 可能开始忘记早期的指令，或反复犯同类错误。烧完之前主动管理。

底部状态栏实时显示上下文使用率（如 `context: 42% (4.2k/10.0k)`），这是你最重要的监控指标。上下文压缩的触发时机和操作细节见[会话与上下文 → 上下文压缩](../guides/sessions.md#上下文压缩)。

### 主动清理上下文

**`/clear`**：完全重置上下文。任务切换时用。上下文里堆满了「修登录 Bug」的记录，再去问架构问题，质量会明显下降。

**`/compact`**：压缩历史，保留关键决策，释放空间。可以指定保留重点：

```
/compact 重点保留我们对 API 设计的决定，以及已修改的文件列表
```

**`/btw`**：侧问模式。回答以浮层形式显示，不进入主对话历史。适合问一个小问题但不想让它占用上下文：

```
/btw 这个函数的返回值是什么类型？
```

`/clear`、`/compact`、`/btw` 的完整参数说明见[斜杠命令参考 → 会话管理](../reference/slash-commands.md#会话管理)。

### 什么时候该开新会话

不是所有情况都要清空——有时保留上下文是对的，历史记录本身就有价值：

- 任务完全切换了？`/clear`
- 同一个问题纠正了两遍还没好，开始绕圈子？`/clear`，重新写一个更精准的 prompt
- 还在同一个问题里深挖？保留上下文

如果你纠正了 Kimi 两次以上它还是做不对，不要再纠正——上下文里全是失败尝试，会干扰后续判断。用 `/clear` 重开，把这次学到的东西写进新 prompt。

### 从源头减少 token 消耗

清理上下文是事后补救，更好的做法是从一开始就少烧 token：

**`@` 引用，不要粘贴**

粘贴文件内容会把整个文件塞进上下文；`@src/auth/session.py` 只占一行路径，Kimi 需要时才读取。对大文件来说，差距可能是几千 token。

**用 Skills 存专业知识，不要每次重复说**

「我们用 SQLite，不用 ORM，所有 SQL 必须参数化查询」这类约定如果每次都写进 prompt，会在每一轮对话里消耗 token。放进 Skill 文件，按需加载，不相关的会话完全不占。

**续接会话，不要频繁新建**

每个新会话都从零开始加载系统提示和工具定义。在同一个会话里续接可以复用已有的 cache，命中率明显高于反复新建。

## 6. 用失败的测试定义「完成」

> 💡 Kimi 说「完成了」不等于真的完成了。把验证条件写进 prompt，而不是事后手动 review。最可靠的验证条件是它无法自己改掉的东西——测试文件。

当 Kimi 能自己验证结果——跑测试、对比截图、检查命令输出——它的表现会显著好于「你来人工看一眼」。

**把验收条件写进 prompt**

| | 示例 |
|---|---|
| ❌ | "实现一个购物车模块" |
| ✅ | "实现购物车模块。完成后跑 pytest tests/test_cart.py，所有测试必须通过才算完成" |
| ❌ | "把这个接口的响应速度搞快一点" |
| ✅ | "这个接口现在 p99 是 800ms，目标是 200ms 以内。改完后跑 locust -f load_test.py --headless -u 100，贴出结果" |

**测试先行：Kimi 无法改掉的规格**

先写失败的测试，再让 Kimi 实现：

```python
# 先写测试（当前应该失败）
def test_empty_cart_raises():
    with pytest.raises(ValueError, match="empty"):
        checkout({"user_id": 1, "items": []})

def test_gold_user_discount():
    assert calculate_discount(100, "gold") == 85.0
```

然后：

```
tests/test_orders.py 里有 2 个测试正在失败。
只修改 main.py 让这两个测试通过。
不能修改 test_orders.py，不能删除或跳过任何测试。
改完用 pytest tests/test_orders.py -v 验证全部通过。
```

测试文件是 Kimi 无法修改的规格。它只能改实现来满足测试，而不能通过改测试来让自己「通过」。结果：Kimi 只加了两行代码——刚好满足两个测试，其他全部不动。

**让 Kimi 自己跑验证**

```
实现完之后，跑 pytest 和 mypy src/。
如果有失败，修复后重跑，直到全部通过才算完成。
```

把验证嵌进任务定义，不是事后追问。

## 7. 对话即沉淀

> 💡 每次对话都是潜在的项目资产。把这次的发现固化下来，让 Kimi 越来越懂你的项目。

### 即时提炼，写进 Skills 或 AGENTS.md

发现了 Kimi 反复踩的坑，或者确认了一个有效的约束？立刻告诉它：

```
把这条规则加进 AGENTS.md：所有 SQL 查询必须用参数化查询，
不用 f-string 拼接，违反的代码直接拒绝审批。
```

这是自我进化机制——每次对话都在让 Kimi 对你的项目理解加深一层。

### 找回上次的对话

Kimi Code 自动保存所有会话，不需要手动备份：

- **续接最近的会话**：`kimi --continue`（或 `-C`），直接接着上次开干
- **从列表里挑**：`kimi --session`（或 `-S`），打开交互式选择器
- **恢复指定会话**：`kimi -r <session-id>`，会话退出时会打印这条命令，直接复制
- **会话内切换**：输入 `/sessions`，不退出也能切换到别的会话；按 `Ctrl-A` 在「当前目录」和「所有目录」之间切换，方便跨项目找

跨天的任务不需要重新解释背景——续接上次的会话，审批决策、Plan 模式状态、子 Agent 实例，全部自动还原。完整的会话存储路径、TUI 内切换和会话恢复说明见[会话与上下文](../guides/sessions.md)。

### 给会话命名，方便找回

用 `/title` 给当前会话起一个有意义的名字（如 `refund-feature`、`auth-migration`）。下次打开 `/sessions` 就能快速认出它，而不是在一堆「2026-05-xx」里翻。

### 保存和复用有价值的会话

用 `/export` 导出对话记录。包含关键决策、架构讨论或复杂 debug 过程的会话值得存档，也可以用 `/import <file>` 导入到新会话作为背景。

### `/undo`：不用怕走错路

`/undo` 打开历史选择器，回退到任意轮次，fork 出新的分支继续，原始会话保留不动。不需要提前想好每一步——觉得方向不对就回退，试另一条路。

::: info
`/undo` 是最新版本新增的命令，当前[斜杠命令参考](../reference/slash-commands.md)页面尚未收录。如果你在菜单里看不到它，先运行 `kimi upgrade` 升级到最新版本。
:::

## 8. 规模输出，无需值守

> 💡 一个人也能跑出团队规模。把任务设计成批量处理、后台运行的形式，启动后去做别的事。

### Print 模式：嵌进脚本和 CI

`kimi --print` 以非交互式运行，处理完后自动退出，适合脚本调用。`--quiet` 是 `--print --output-format text --final-message-only` 的快捷方式，只输出最终结果。（这两个标志属于新版 CLI 功能，当前[命令参考](../reference/kimi-command.md)暂未收录，正式文档即将更新。）

```bash
# 单次执行
kimi --print -p "检查 src/ 下是否有 SQL 注入风险，输出有问题的文件列表"

# 只要最终结果（跳过中间过程）
kimi --quiet -p "根据当前 git diff 写一个 commit message"

# 流式 JSON 输出，方便程序解析
kimi --print -p "分析这个模块的接口设计" --output-format stream-json
```

### 批量处理多文件

对于大规模迁移或批量修改：

```bash
# 批量迁移 Python 文件（加 --yolo 自动批准所有操作）
for file in $(cat files.txt); do
  kimi --print --yolo -p "把 $file 里的 f-string SQL 查询全部改成参数化查询，改完提交"
done
```

先在 2–3 个文件上验证 prompt 效果，确认没问题再全量跑。

### 后台并行任务

对于耗时较长的分析任务，让 Kimi 在后台跑：

```
用后台 subagent 扫描 src/ 下所有文件的 SQL 查询，
列出所有用 f-string 拼接的位置，输出文件名和行号
```

用 `/tasks` 查看后台任务状态，三列 TUI：任务列表、详情、输出预览。

### 退出码：让脚本自己判断

Print 模式用结构化退出码表示执行结果：

| 退出码 | 含义 |
|---|---|
| `0` | 成功完成 |
| `1` | 永久性失败（认证错误、配置错误、额度耗尽） |
| `75` | 暂时性失败，可重试（限流、服务器错误、连接超时） |

```bash
#!/bin/bash
for file in $(cat files.txt); do
  kimi --print --yolo -p "迁移 $file"
  code=$?
  if [ $code -eq 75 ]; then
    echo "$file: 触发限流，加入重试队列"
    echo $file >> retry.txt
  elif [ $code -eq 1 ]; then
    echo "$file: 永久失败，需要人工处理"
  fi
done
```

## 常见失败模式

- **大杂烩会话**：一个会话里混了多个无关任务，上下文充满噪音。
  > **解决**：任务切换时用 `/clear`。

- **反复纠错却不收敛**：同一个问题纠正了两三次还没好，越改越乱。
  > **解决**：纠错两次后停下来，`/clear` 重来，把这次学到的约束写进新 prompt。

- **AGENTS.md 越写越长**：超过一定长度，重要规则开始被忽略。
  > **解决**：无情精简。如果不写这行 Kimi 也能做对，就删掉；需要强制执行的规则改用 Hook。

- **信任而不验证**：Kimi 给了一个看起来完整的实现，实际上没覆盖边界情况。
  > **解决**：始终在 prompt 里指定验证方式，不能验证就不算完成。

- **无边界的探索**：让 Kimi「调研一下」，结果读了几百个文件，上下文爆了。
  > **解决**：限定调研范围（「只看 src/auth/ 下的文件」），或用 subagent 探索——它在独立上下文里跑，不影响主会话。

## 下一步

- [常见使用案例](../guides/use-cases.md) — 具体场景（功能开发、Bug 修复、批量任务）下的完整操作流程
- [交互与输入](../guides/interaction.md) — Plan 模式、文件引用、审批流程的完整说明
- [会话与上下文](../guides/sessions.md) — 会话存储、恢复、压缩的机制细节
- [Hooks](../customization/hooks.md) — 用脚本强制执行规则，而不是依赖 AI 记得
- [MCP](../customization/mcp.md) — 让 Kimi 直连外部系统（数据库、Linear、Sentry 等）
- [Agent Skills](../customization/skills.md) — 把专业知识打包成按需加载的 Skill 文件
