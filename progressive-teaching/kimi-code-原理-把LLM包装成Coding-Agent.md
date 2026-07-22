# Kimi Code 是如何把 LLM 包装成一个 Coding Agent 的

## 第一层：直觉 — 先打个比方

> "给 LLM 装上一副**手和眼睛**，再给它一本**操作手册**。"

想象你是一个**远程专家**（LLM），坐在机房里，面前只有一个屏幕和键盘。你的雇主通过屏幕给你发消息说"帮我把那个文件里的 bug 修了"。

你看不到周围的环境，不知道文件在哪，也不知道桌上有啥工具。这时候，**雇主（Kimi Code 的框架）**做了四件事：

1. **给了你一张地图** — "你现在在 `/project/src/`，这里有这些文件…"
2. **给了你一套工具清单** — "你可以用 `Read` 读文件、用 `Edit` 改代码、用 `Bash` 跑命令、用 `Grep` 搜索…"
3. **在你桌上放了块白板** — "复杂的问题可以先写计划在上面"
4. **装了个对讲机** — "拿不准的时候可以问我"

你每看完信息、做完操作，就告诉雇主"我做完了，下一轮"。雇主把你的操作结果贴回屏幕，你再决定下一步。这就是 **Kimi Code 的核心 loop**。

**简单来说：**
原始 LLM 像是一个只会"回答问题"的知识分子。Kimi Code 给它装了工具、给了上下文、设计了工作流，它就变成了一个**能动手干活儿的工程师**。

> 思考题：你觉得在这个类比里，最核心的"魔法"是哪一步？是给了工具，还是那个"做完告诉我，我再告诉你结果"的循环？

---

## 第二层：动手 — 走一遍真实流程

让我们用 `kimi -p "把 main.ts 里的 greet 函数改成异步的"` 这条命令，追踪底层发生了什么。

### 启动阶段

```
main()
  → createProgram()           // Commander.js 解析命令行
  → runPrompt()               // 进入 headless 模式
    → createPromptHarness()   // 创建 SDK harness
      → Session.createMain()  // 创建 Session
        → new Agent(...)      // 创建 Agent，组装所有子系统
        → bootstrapAgentProfile("agent")  // 加载 agent 配置文件
```

关键动作在 `bootstrapAgentProfile`：它读取了 `packages/agent-core/src/profile/default/` 下的**配置文件**，包括：

- `agent.yaml` — 定义这个 profile 用哪些工具、继承谁
- `system.md` — **系统提示词模板**（Nunjucks 模板引擎）

### 渲染系统提示词

`system.md` 模板里长这样（简化）：

```
你现在是 Kimi Code，一个 AI 编程助手。
操作系统: {{ KIMI_OS }}
当前工作目录: {{ KIMI_WORK_DIR }}
目录结构:
{{ KIMI_WORK_DIR_LS }}

项目指南 (AGENTS.md):
{{ KIMI_AGENTS_MD }}

可用技能:
{{ KIMI_SKILLS }}
...
```

在运行时，`prepareSystemPromptContext()` 会做这些事情：

1. 跑 `uname` 获取操作系统信息
2. 跑 `ls` 列出当前目录
3. 从 CWD 向上递归找所有 `AGENTS.md` 文件，合并内容
4. 列出所有可用技能的清单
5. 把这些变量填入 Nunjucks 模板

**结果是一个几百到几千字的系统提示词**，塞进 LLM 的 `system` 参数里。

### 执行一轮对话

现在用户输入 "把 main.ts 里的 greet 函数改成异步的"：

```
Agent.turn.prompt(userInput)
  → ContextMemory.appendUserMessage("把 main.ts 里的 greet 函数改成异步的")
  → runStepLoop():
    Step 1:
      1. injectionManager.inject()  // 注入权限提醒、plan mode 状态等
      2. ContextMemory.project()     // 把内部消息转为 LLM 能理解的格式
      3. llm.chat(system + messages + tools)  // 调用 kosong.generate()
      4. LLM 回复: tool_use → Read(path="main.ts")
      5. 执行 Read 工具 → 读取文件内容
      6. 把 Read 结果追加到 context
      7. 循环到 Step 2

    Step 2:
      1. injectionManager.inject()
      2. ContextMemory.project()  // 现在包含 Step 1 的对话
      3. llm.chat(...)
      4. LLM 回复: tool_use → Edit(path="main.ts", old_string="function greet", new_string="async function greet")
      5. 执行 Edit 工具 → 修改文件
      6. 循环到 Step 3

    Step 3:
      1. llm.chat(...)
      2. LLM 回复: text "已完成，已将 greet 改为异步函数"
      3. stop_reason = end_turn
      4. 退出循环

    → emit turn.ended
```

### 工具调用机制

每个工具的格式是 OpenAI 风格的 `function calling` 定义：

```json
{
  "name": "Read",
  "description": "读取文件内容",
  "parameters": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "文件路径" }
    },
    "required": ["path"]
  }
}
```

LLM 返回 `tool_use` 后，Kimi Code 会：

1. **`authorizeToolExecution`** — 权限检查（自动放行？弹窗确认？禁止？）
2. **`runToolCallBatch()`** — 批量执行工具（可以并行跑多个工具调用）
3. **收集结果** — 把 stdout、文件内容、错误信息等放回 context
4. **`finalizeToolResult`** — 对结果做后处理（比如截断过长的输出）

### 核心循环的伪代码

```typescript
async function runStepLoop(): Promise<TurnResult> {
  while (stepCount < maxSteps) {
    const response = await llm.chat({
      system: currentSystemPrompt,
      messages: context.project(),
      tools: toolManager.getTools()
    });

    if (response.hasToolCalls()) {
      for (const call of response.toolCalls) {
        const result = await toolManager.execute(call);
        context.appendToolResult(call, result);
      }
      stepCount++;
      continue;  // 把工具结果发回给 LLM，让它决定下一步
    }

    // 没有工具调用，对话结束
    return { stopReason: response.stopReason, text: response.text };
  }
}
```

这就是 **"思考 → 行动 → 观察 → 再思考"** 的循环，也是 Coding Agent 最根本的工作模式。

> 思考题：如果 LLM 在一个 step 里同时调用了 Read 和 Edit，你觉得会发生什么？顺序执行还是并行？

---

## 第三层：为什么 — 解决了什么问题

理解了"是什么"和"怎么跑"之后，我们来思考**为什么需要这么多层包装**。

### 核心矛盾：LLM 天生是个"纯文本处理器"

| LLM 能做的 | 编程需要做的 |
|---|---|
| 读一段文字，续写一段文字 | 读文件、写文件、跑命令、看结果 |
| 有上下文窗口（有限） | 项目可能有成千上万个文件 |
| 回答你问的 | 主动诊断问题、规划方案 |
| 不知道当前目录 | 要在具体的工作目录里操作 |

Kimi Code 的每一层包装，都是在填补这个鸿沟：

#### 1. 工具系统 — 给 LLM 装上"手"

没有工具的话，LLM 只能建议你"你可以这样改那个文件"——它自己动不了手。工具系统让 LLM **直接操作文件系统**、**执行命令**、**搜索代码**。

对比一下，**没有工具的 LLM** vs **有工具的 Kimi Code**：

```
用户: "找到所有未使用的 import"
ChatGPT: "你可以在终端里运行 eslint --rule 'no-unused-vars: error' 来检查"

Kimi Code: 自动调用 Bash("eslint --rule 'no-unused-vars: error'")
           看到输出，调用 Edit 逐个删除未使用的 import
           然后调用 Bash("npm test") 确认没有 break 任何东西
```

#### 2. 上下文管理 — 给 LLM 装上"记忆"

LLM 的上下文窗口是有限的（Claude 3.5 是 200K token）。Kimi Code 做了：

- **Compaction（压缩）** — 当对话太长时，把早期内容总结成摘要，保留最近的细节
- **Token 追踪** — 实时跟踪已用 token 数，在接近上限前自动触发压缩
- **选择性保留** — 压缩时保留关键信息（用户指令、系统提示、最近几步）

没有这个，长会话到一半 LLM 就会"失忆"。

#### 3. Injection 系统 — 给 LLM 装上"情境意识"

每次调用 LLM 前，Kimi Code 会注入当前状态提醒：

- 当前权限模式（yolo/auto/normal）
- 是否在 plan mode
- 当前的 todo 列表状态
- 活跃的 goal 目标
- 插件会话状态

这些提醒确保 LLM **知道自己处于什么模式**，做出符合当前语境的行为。

#### 4. 权限系统 — 给 LLM 装上"刹车"

LLM 可能会执行危险操作（删除文件、安装不明包）。权限系统用一个**策略链**逐层检查：

```
deny-all → default-tool-approve → user-rules → auto-mode → yolo-mode → plan-mode → file-ask → fallback-ask
```

每个工具调用都要经过这个链，决定是**放行、拒绝、还是问用户**。

#### 5. Profile 系统 — 给 LLM 装上"角色切换"

不同的任务需要不同的"性格"和工具组合：

- `agent` profile — 全能助手，默认使用
- `coder` profile — 专注编码，更多文件操作工具
- `explore` profile — 只读探索代码库
- `plan` profile — 专注架构规划

每个 profile 有自己的一套系统提示词、工具集和参数配置。

> 思考题：你觉得如果去掉"工具系统"，只靠文字交互，Kimi Code 还能完成多少编程任务？反过来，只给工具不管理上下文呢？

---

## 第四层：细节 — 工程实现的关键设计

现在深入看看几个关键的工程实现细节。

### 1. 工具系统的内部设计

每个工具都是 `ExecutableTool` 接口的实现：

```typescript
// packages/agent-core/src/loop/types.ts
interface ExecutableTool {
  name: string;
  description: string;
  parameters: JSONSchema;

  resolveExecution(args: unknown): {
    invoke(): AsyncIterable<ExecutableToolResult>;
  };
}
```

**工具分为三个来源：**

```
Builtin tools         User tools           MCP tools
(代码中写死的)        (用户通过API注册的)    (通过 MCP 协议动态连接)
  Read                  自定义工具              mcp__server__tool
  Write                                         
  Edit                                          
  Bash                                          
  Grep                                          
  ...                                            
```

有趣的设计：**Progressive Disclosure（渐进式暴露）**。当连接的 MCP 服务器很多（几十个工具）时，不会一股脑全塞给 LLM。而是：

1. 在 `tools` 参数里放 `SelectTools` 这个特殊工具
2. LLM 先调用 `SelectTools({ "query": "我想找个 redis 工具" })` 来搜索可用工具
3. 搜索到后再按需加载

这解决了 **LLM 上下文窗口里 tools 参数超长** 的问题。

### 2. Context Memory 的"投影"机制

`ContextMemory` 内部维护的不是 LLM 看到的格式，而是**带元数据**的内部格式：

```typescript
interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: ContentPart[];
  origin?: 'input' | 'tool_result' | 'injection' | 'summary';
  sourceToolCall?: string;  // 如果是工具结果，关联到哪个工具调用
  messageId?: string;
}
```

`project()` 方法做转换时：

- 去掉 `origin` 等内部元数据
- **处理微压缩**（Micro Compaction）— 如果用户消息的文本部分太大，用 token 估算替换为简短摘要
- **丢弃孤儿工具结果** — 如果某个工具调用消息因为压缩被移除了，它的结果也要移除
- **处理 tool_use / tool_result 配对** — 确保 LLM 看到的消息结构正确

### 3. Compaction 的两种策略

**Full Compaction（完整压缩）**：
```
压缩前: [system][user1][assistant1][user2][assistant2]...[user50][assistant50]
                                                    ↑ token 预算已满
压缩后: [system][summary of old turns][user45][assistant45]...[user50][assistant50]
                                                    ↑ 保持最近 5 轮完整
```
通过 `llm.chat()` 调用 LLM 生成 JSON 格式的摘要，然后替换早期内容。

**Micro Compaction（微压缩）**：
如果某条 user 消息的 text 部分特别长（比如贴了一大段日志），在 `project()` 时用 token 估算替换为"用户粘贴了很长一段文字（约 X token）"，节省上下文给更重要的内容。

### 4. 系统提示词模板的 Nunjucks 引擎

为何不用简单的字符串拼接？因为模板里有很多条件逻辑：

```
{% if KIMI_AGENTS_MD %}
项目指南：
{{ KIMI_AGENTS_MD }}
{% endif %}

{% if KIMI_SUBAGENTS_AVAILABLE %}
你可以通过 Agent 工具分派子任务...
{% endif %}
```

而且 profile 可以**继承**（`extends: base-agent`），模板变量可以**覆盖**。

### 5. Records & Replay（有线日志）

每次 LLM 调用、工具执行、上下文变更，都会以 JSONL 格式写入 `~/.kimi-code/wire.jsonl`：

```jsonl
{"type": "turn.prompt", "payload": {...}, "ts": "..."}
{"type": "context.append_message", "payload": {...}, "ts": "..."}
{"type": "loop.step", "payload": {...}, "ts": "..."}
```

`agent.resume()` 时重放这些记录，还原整个对话状态。这就是 **`kimi -r` 恢复会话**能力的底层实现。

> 思考题：传统的 Agent 框架（如 LangChain）和 Kimi Code 在工具实现上最大的区别是什么？提示：想想工具的数量和选择性暴露。

---

## 第五层：关联 — 更大的技术地图

### Kimi Code 与其他框架的对比

| 维度 | Kimi Code | LangChain / LangGraph | OpenAI Assistants API |
|---|---|---|---|
| 架构风格 | 单体 Agent + 丰富内置工具 | 链式 / 图式编排 | API 托管 |
| 工具系统 | 内置 20+ 工具 + MCP + 渐进式暴露 | 依赖社区工具包 | 内置 code_interpreter / retrieval / function calling |
| 上下文管理 | 自动双策略压缩（全量 + 微压缩） | 需要手动配置 | 自动但不可控 |
| 会话持久化 | 本地 JSONL 有线日志 | 依赖外部存储 | OpenAI 托管 |
| 子代理 | Agent 工具（内建子代理协议） | LangGraph 子图 | 无 |
| 权限控制 | 多层策略链（yolo/auto/ask/deny） | 无内置 | 无 |
| Profile 系统 | 模板 + YAML + 继承 | 无 | 无 |

### 设计哲学的演变趋势

Kimi Code 代表了 **Agent 框架从"玩具"走向"产品"** 的几个趋势：

**1. 从 Function Calling 到 Tool-Use Protocol**

早期：LLM 调用函数，返回结果
现在：Kimi Code 通过 MCP（Model Context Protocol）让工具成为**可发现、可组合、可远程连接**的资源。任何 MCP 服务器都可以动态提供工具。

**2. 从单轮到多步推理**

- 1 步：`Q → A`
- N 步：`Q → think → act → observe → act → observe → ... → A`

这不仅仅是多调几次 LLM，而是**完整的执行引擎**——带重试、权限、并发执行工具、结果预算管理。

**3. 从无状态到有状态**

- Agent 需要记住对话历史和已完成的操作
- 需要知道当前权限模式、goal 状态、cron 任务
- 跨会话恢复（`kimi -r`）需要持久化有线日志

**4. 从单一角色到多角色切换**

通过 Profile 系统，同一个 Agent 框架可以切换不同的"人格"（agent / coder / explore / plan），每个角色有自己的系统提示、工具组合和行为模式。

**5. 从"回答问题"到"自主工作"**

- Goal 模式：设定一个目标，Agent 自主推进直到完成或遇到障碍
- Cron 定时任务：Agent 按计划自动执行
- 子代理分发：复杂任务拆成多个子任务并行处理

### Kimi Code 的 v1 → v2 演进

v1（当前默认）是**单体 Agent**——Agent 类里包含所有子系统，通过组合模式组织。

v2（正在开发）转向 **DI × Scope 架构**——借鉴 VS Code 的依赖注入和服务作用域：

```
App scope → Session scope → Agent scope
  ↑            ↑               ↑
全局服务     会话级服务       每轮对话级服务
(config)     (session state)   (turn context)
```

这带来更好的**可测试性**、**可扩展性**，以及服务粒度的生命周期管理。

### 未来方向

从 Kimi Code 的代码库可以看出这些趋势：

- **更多模态**：已经支持图片理解（image_in capability），视频处理
- **更丰富的子代理协作**：AgentSwarm 工具可以并行启动多个子代理
- **更细粒度的权限控制**：用户可以为特定文件/命令配置自动化规则
- **更好的上下文经济**：微压缩、智能分层、选择性保留

---

好了，这就是 Kimi Code 包装 LLM 为一个 Coding Agent 的完整故事。从最朴素的"给 LLM 装手"的直觉，到具体的工具调用循环，再到工程实现的细节，最后放到整个 Agent 框架生态中看它的位置。

你还想深入了解哪个部分？比如具体的**工具实现细节**、**权限策略链的工作方式**、还是 **v2 引擎的 DI 架构**？
