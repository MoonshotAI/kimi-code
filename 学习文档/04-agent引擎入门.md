# 04 · Agent 引擎入门

> 时效基线：基于 commit `d4e0ad4b2`（2026-08）。
> 面向"熟 TS、不熟 agent"的读者：前半补概念，后半读代码。引擎指 `packages/agent-core-v2`（v2，默认），v1 见 `06-支撑包速览.md`。

## 一、先补 agent 概念（对着本仓讲）

### 1. coding agent = LLM + 工具循环

Agent 的本质是一个循环：

```
用户输入
  ▼
┌─────────── turn（一轮对话）───────────┐
│  step 1: 组装上下文 → 请求 LLM          │
│          LLM 返回文本 和/或 工具调用     │
│          执行工具（Bash/Read/Edit…）    │
│          结果写回上下文                  │
│  step 2: 再请求 LLM（带着工具结果）      │
│          ……直到 LLM 不再调工具           │
└──────────────────────────────────────┘
  ▼
轮次结束，等待下一个用户输入
```

- **turn**：一次用户输入到回答完成的整个过程；**step**：turn 内的一次 LLM 请求 + 工具批执行。一个 turn 通常有多个 step（比如模型先 Read 再 Edit 再回复）。
- 本仓的落点：v2 引擎的 `packages/agent-core-v2/src/agent/loop/`（`loop.ts`、`turnOps.ts`、`stepRequest.ts`）；step 数有上限（max-steps），防失控。
- 你在 VS Code 插件里看到的"正在执行 Edit…"、"思考中"，就是循环里的事件被 `event-adapter.ts` 转成了 UI 流。

### 2. 上下文窗口与 compaction

LLM 每次请求能看到的内容有限（上下文窗口）。对话 + 工具结果会不断膨胀，所以引擎要有上下文管理：把历史消息投影成当次请求的最终消息列表，并在快满时**压缩**（compaction：把早期内容摘要化、丢掉冗余工具输出）。

- 本仓落点：`src/agent/contextMemory/`（上下文记忆）、`src/agent/contextProjector/`（投影成请求）、`src/agent/fullCompaction/`（压缩）、`src/agent/tokenCounting/`（token 计数）。
- 工具结果截断是另一道闸：`src/agent/toolResultTruncation/`。

### 3. 工具（tools）

工具 = 引擎暴露给 LLM 的能力，每个工具有名字、JSON Schema 参数定义、描述文本（LLM 靠描述决定何时用）与执行函数。内置工具就是你在用的那些：读文件、编辑、跑 shell、glob/grep、fetch、todo-list……

- 本仓落点：`src/agent/tools/`（`os/read`、`os/bash`、`edit/`、`fetch-url`、`web-search`、`todo-list`、`ask-user-question`、`task/`、`skill/`…）；周边域：`toolRegistry`（注册）、`toolSelect`（模型可见哪些）、`toolExecutor`（执行）、`toolApproval`（要不要人工批准）、`toolPolicy`（策略否决）、`toolDedupe`（重复调用去重）。工具契约与校验在 `src/tool/`（`toolContract.ts`、args-validator 等）。

### 4. 权限与审批

危险工具（写文件、跑命令）执行前要过权限门。模式从"每次询问"到"全自动"（YOLO）不等；宿主 UI 收到审批请求 → 用户点允许/拒绝 → 引擎继续。这就是插件里 `ApprovalDialog` + `reverse-rpc.ts` 那条链的引擎侧源头。

- 本仓落点：`src/agent/permissionGate/`、`permissionMode/`、`permissionPolicy/`、`permissionRules/`、`toolApproval/`；策略文档见 `packages/agent-core-v2/docs/Permission.md`。

### 5. 会话持久化与 resume

每个会话的完整历史（消息、工具调用、状态变更）以**追加式事件日志**（每个 agent 一个 `wire.jsonl`）持久化。重启 / 切换设备后 resume：重放日志恢复状态。你在插件里看到的历史会话列表、fork 会话，都建立在这之上。

- 本仓落点：`src/persistence/`（backends + interface）、`src/wire/`（事件词汇表）；跨端渲染用的 `packages/transcript`（见 `06`）把同一份日志投影成 UI 需要的数据层。

### 6. 其他高频词

| 词 | 含义 | 本仓落点 |
|---|---|---|
| system prompt / profile | 决定 agent 人设与行为的系统提示词配置 | `src/agent/profile/`、`src/agent/prompt/` |
| skill | 打包的"某类任务怎么做"说明书（markdown + 资源） | `src/agent/skill/`、workspace 的 skill catalog |
| MCP | 外接第三方工具/数据源的协议（Model Context Protocol） | `src/mcpCore/`、`src/agent/mcp/`、workspace 域的 `workspaceMcp` |
| subagent | 派生子 agent 干子任务（如并行搜索），有自己的 agent 作用域 | `src/session/subagent/` |
| plan 模式 | 先读代码出方案、批准后再动手的交互模式 | feature `src/features/plan/` |
| steer | 生成途中插入用户补充指令 | `SessionRuntime` 的 steer 链路 |
| hooks | 在特定事件点跑用户脚本 | feature `src/features/externalHooks/` |

## 二、接缝层：node-sdk 与 klient（插件往下钻的下一站）

### node-sdk（`@moonshot-ai/kimi-code-sdk`）

宿主看到的全部 API：`KimiHarness`（进程级：配置、auth、MCP、会话工厂）与 `Session`（会话级：`prompt()`、`onEvent()`、审批/提问处理器）。两个入口：

- **v2（默认）**：`createKimiHarnessV2`（`packages/node-sdk/src/sdk-rpc-client-v2.ts:2978`）构造 `SDKRpcClientV2`（类在 `packages/node-sdk/src/sdk-rpc-client-v2.ts:395`）。文件头注释（1-8 行）值得整段读：v2 引擎**进程内引导**，所有调用经 **klient 的 memory transport**——"每次调用都经过与网络传输相同的契约校验和 JSON 往返"。也就是说 SDK 没有绕过任何一层去直接摸引擎对象。
- **v1（回退）**：`createKimiHarness`（`packages/node-sdk/src/sdk-rpc-client.ts:145`）直接 `new KimiCore(...)`（`packages/node-sdk/src/sdk-rpc-client.ts:78`）包成 RPC 对。
- `src/v2/` 目录是纯映射层（session-mapper、event-mapper…），把 v2 形状还原成 v1 的对外形状——对外 API 在引擎换代时保持稳定。

### klient（`packages/klient`）

v2 引擎的**契约驱动 facade**：三层结构（见其 `AGENTS.md`）：

- **Facade**（`src/core/klient.ts`、`src/core/facade/`）：`klient.global.*`（配置/插件/flags/会话索引）、`klient.session(id).*`（会话操作）、`klient.session(id).agent(id).*`（prompt/steer/取消、模型与权限设置）；
- **Contract**（`src/contract/`）：zod schema，与引擎类型镜像，所有跨层数据经它校验；
- **Transport**（`src/transports/`）：`memory`（进程内，插件用）与 `ipc`（跨进程）——同一 facade 两种部署形态。kap-server 走的是自己的一层 REST/WS，但契约同源。

**学习意义**：这是"如何把一个引擎做成可嵌入 SDK"的范本——引擎内部是 DI 容器，对外只暴露窄接口 + 契约校验。做二次开发嵌入自己宿主时，直接用 node-sdk（参照 `apps/vscode/src/runtime/kimi-runtime.ts` 的用法即可）。

## 三、agent-core-v2 地图

```
src/
├── _base/     DI 内核（scope 容器、级联引擎、@ref、生命周期账本）—— 不含业务
├── app/       App 层：scopes、配置、模型目录、flag、workspace 域、会话管理
├── session/   会话域：生命周期、交互、审批、subagent、todo…
├── agent/     Agent 域（最常读）：loop、llmRequester、tools、permission*、context*、profile…
├── features/  自组装特性：plan、goal、swarm、tower、externalHooks…
├── tool/      工具契约与校验等横向设施
├── kosong/    内嵌的 LLM 抽象层（contract/model/protocol/provider）
├── mcpCore/   MCP 连接核心（scope 无关）
├── os/ runtime/  进程/文件/执行环境（v2 不用 kaos）
├── persistence/ wire/ state/   持久化与事件词汇
└── debug/     调试自省（--debug-endpoints 的后端）
```

### Scope 分层（先纠正一个易错点）

`src/app/scopes.ts:3` 的 `LifecycleScope` 枚举只有**三个**成员：`App` / `Session` / `Agent`。"Workspace 层"不是枚举值，而是**域层概念**：App 层的 `workspaceLifecycle` 服务持有"每个 workspaceId 一个 handler"的注册表，handler 再持有该 workspace 的会话生命周期（create/resume/fork/close），并挂 Workspace 级共享资源（skill catalog、MCP、git、trust…）。`packages/agent-core-v2/AGENTS.md` 里"四层"的说法指这种概念分层。

**会话组合入口**（kap-server 与 node-sdk 都走这条链）：

```
sessionIndex（App 层索引）
  → workspaceLifecycle.handlerFor(workspaceId)（拿到该 workspace 的 handler）
    → handler 的 sessionLifecycle（create/resume/fork 会话，作为其子作用域）
```

### DI 内核要点（`_base/di`，读代码前的最小知识）

- 一切服务是 **unit**，五状态（Pending/Activating/Active/Unloading/Failed）；注册走 `provide`，撤销走 `unprovide`，级联引擎处理依赖联动（事务化、跨作用域 teardown）。
- `@ref(IX)` 装饰器拿"活引用"：观察不建立依赖边，适合读可能被热替换的服务。
- 贡献点（contribution seams）是扩展引擎的正规姿势：config section、agent tool、agent profile、事件/状态词汇、可执行命令各有一个 token→fold 通道。加内置工具/配置段就往这里挂（`registerAgentToolService`、`registerConfigSection` 等静态通道）。

### 引擎怎么发起一次 LLM 请求

`src/agent/llmRequester/`（`llmRequesterService.ts`）是组装点：contextMemory（该放哪些历史）→ contextProjector（投影成消息数组）→ profile（system prompt/人设）→ toolRegistry/toolSelect（本轮可见工具及 schema）→ tokenCounting（预算）→ 调内嵌 kosong 层 → 拿到流式响应交回 loop。想看清"模型到底看到了什么"，从这里下断点最快（用 §03 的 CLI attach 方式）。

## 四、精读路线（建议顺序）

1. `packages/agent-core-v2/AGENTS.md` —— 先通读，接受词汇（scope/unit/seed/contribution）；
2. `src/agent/loop/loop.ts` —— turn/step 状态机、max-steps、中断安全点；
3. `src/agent/llmRequester/` —— 一次请求的组装；
4. 挑两个工具读完整闭环：`src/agent/tools/os/read*`（简单）+ `edit/`（带审批与 baseline 联动）；
5. `src/agent/permissionGate/` + `toolApproval/` —— 审批链；
6. `src/agent/contextMemory/` + `fullCompaction/` —— 上下文管理；
7. `src/persistence/` + 一个 `wire.jsonl` 文件 —— 持久化形状（配合 vis 看更直观）；
8. `src/features/plan/` —— 看一个 feature 如何用贡献点组装。

配套内部文档：`packages/agent-core-v2/docs/`（`di.md`、`service-design.md`、`flag.md`、`Permission.md`、`errors.md`、`rw-model-design.md`）。

## 五、动手练习

- [ ] CLI attach 调试（§03 做法 A），断点在 `llmRequester`，问模型一个问题，把最终消息数组（system + 历史 + 工具 schema）抄下来研究。
- [ ] 找到 Edit 工具的执行函数，跟踪一次编辑从"模型返回 tool call"到"文件落盘"的全过程，标出审批发生在哪一步。
- [ ] 给 `packages/agent-core-v2` 里任一现有测试加一个断言并跑绿（用它练"单包测试 + JS Debug Terminal"）。
- [ ] 写 20 行脚本用 node-sdk 起一个 harness、创建会话、发一句 prompt、打印事件流（参照 `apps/vscode/src/runtime/kimi-runtime.ts` 与 node-sdk 测试）。

## 下一步

→ `05-CLI与服务器.md`（同一引擎的另外两种宿主形态）
