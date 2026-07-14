# `src/core` — TUI 的 agent-core-v2 门面

本文档记录 `apps/kimi-code` 交互式 TUI 从 v1 SDK（`@moonshot-ai/kimi-code-sdk` 的 `KimiHarness`/`Session`）切换到 `packages/agent-core-v2`（DI × Scope 引擎）的架构、用法、缺口与维护要点。读者是改 core 门面或 TUI 的开发者。

设计推导见 `.tmp/agent-core-v2-tui-direct-design.md`，实施计划见 `.tmp/agent-core-v2-tui-direct-plan.md`（均在 `.tmp/`，不入库）。

## 1. 它是什么 / 为什么存在

TUI 现在跑在 agent-core-v2 上，但 **TUI 文件不直接 import agent-core-v2**，也不经过 v1 SDK 的 `KimiHarness`/`Session` 类。中间这层 `src/core/` 是一个**薄门面**：

- 对内：持有 v2 的 App `Scope`，方法内部直接 `handle.accessor.get(IXxxService)` 调 v2 服务（App / Session / Agent 三层 scope）。
- 对外：暴露 `CoreHarness` / `CoreSession` 两个类 + v2 原生类型（经 `index.ts` re-export），TUI 全部 import `#/core`。

**这不是协议桥接层。** 事件 payload 是 v2 原生（只补 `agentId`/`sessionId` 路由上下文），交互是 v2 pending 模型直出，方法直接调 v2 服务。门面存在的唯一理由是把 v2 的 DI/Scope 细节收敛在一个地方，给 TUI 一个稳定的、按 TUI 需求裁剪的接口面。

范围边界：

- **只有交互式 TUI 走这里。** print（`src/cli/v2/`）、ACP、其他子命令继续用 `@moonshot-ai/kimi-code-sdk`（v1），不动。
- `packages/node-sdk`、`packages/agent-core` 一行不改。`packages/agent-core-v2` 仅在 facade 需要时补 **type-only** barrel 导出（不改逻辑、不扩值导出）；v2 缺失的能力仍一律降级 + `TODO(v2-gap)` 标记。

## 2. 架构

```
run-shell.ts ── createCoreHarness(...) ──> CoreHarness ── createSession/resumeSession ──> CoreSession
                                                  │                                       │
                                                  └─ App Scope (bootstrap)                └─ ISessionScopeHandle
                                                  (进程唯一)                                + agent handle 路由
                                                                                            accessor.get(IXxxService)
                                                                                            ├─ events.ts   事件合流
                                                                                            └─ approvals/questions pending 直出
```

- `bootstrap()` 产生进程唯一的 App `Scope`，持有到退出。
- 一切能力 = `handle.accessor.get(IXxxService)`，严格按 App / Session / Agent 三层从对应 handle 取。
- main agent 通过 `ensureMainAgent(handle)` 惰性物化；其他 agent 经 `IAgentLifecycleService.getHandle(id)` 解析。

## 3. 文件职责

| 文件 | 职责 |
|---|---|
| `index.ts` | barrel：`createCoreHarness` / `CoreHarness` / `CoreSession` + core 自有类型 + v2 类型 re-export |
| `harness.ts` | `CoreHarness`：bootstrap、session CRUD、config、插件、telemetry、auth 持有 |
| `session.ts` | `CoreSession`：对话流、模式、查询、goal/task、skills、事件、交互子对象 |
| `events.ts` | 多 agent `IEventBus` + App 级 `IEventService` 合流成 session 单一事件流 |
| `replay.ts` | resume 回放数据组装（`getResumeState()` 数据源） |
| `transcript.ts` | wire records → 渲染 transcript 的 fold（`defineDerivedModel` 形态、facade 手动 fold）；条目类型 `TranscriptMessage` 与喂模型的 `ContextMessage` 隔离 |
| `errors.ts` | `CoreError` / `CoreErrorCodes` / `isCoreError`（错误码值与 v1 wire 一致） |
| `types.ts` | core 自有类型（`SessionEvent` / `SessionStatus` / `ResumedSessionState` / 投影类型等） |
| `auth.ts` | re-export SDK 的 `KimiAuthFacade`（`TODO(migrate)`，见 §7） |
| `catalog.ts` | catalog 纯函数转口（`TODO(migrate)`，见 §7） |

## 4. TUI 如何消费

```ts
import { createCoreHarness, type CoreHarness, type CoreSession, type SessionEvent } from '#/core/index';

const harness = createCoreHarness({ homeDir, identity, telemetry, onOAuthRefresh, ... });

// 启动时可以不建 session：先拿 config 级默认（模型 / 上下文窗口 / 模式）渲染首屏，
// 第一条用户消息再 lazy 创建 session（TUI 的 sendNormalUserInput 路径）。
const startup = await harness.getStartupState();
const session = await harness.createSession({ workDir, model, permission, planMode });

// 对话流
await session.prompt(parts);                      // 默认路由到 main agent
await session.prompt(parts, { agentId: btwId });  // 显式 agent 路由（替代 v1 的 withInteractiveAgent）
await session.steer(parts);
await session.cancel();

// 事件（合流后的 session 单一流，返回退订函数）
const off = session.onEvent((event: SessionEvent) => { ... });

// 交互（v2 pending 模型）
session.approvals.onDidChangePending(() => {
  for (const p of session.approvals.list()) { /* 驱动审批面板 */ }
});
session.approvals.decide(id, { decision: 'approved' });
session.questions.answer(id, result);
session.questions.dismiss(id);

// 模式 / 查询
await session.setModel('kimi-latest');
await session.setPermission('yolo');
const status = await session.getStatus();
```

TUI 文件**只 import `#/core/index`**。不要把 agent-core-v2 的服务 identifier 漏进 TUI 组件——需要新能力时，先在 core 门面加方法。

## 5. v1 → v2 迁移速查

从 v1 SDK 迁到 core 门面时，下列行为触点需要对应改造（已在 TUI 切换中落实，记录在此供后续参考）。

### 5.1 事件名

v2 事件 kind 与 v1 几乎一致，唯一改名：

| v1 (`background.task.*`) | v2 (`task.*`) |
|---|---|
| `background.task.started` | `task.started` |
| `background.task.terminated` | `task.terminated` |

事件形状：`SessionEvent = DomainEvent & { agentId, sessionId }`。core 只补路由上下文，不改 payload。`session-event-handler.ts` 按 `event.agentId` 做 subagent 路由。

### 5.2 交互模型

| v1（handler 回调） | v2（pending 模型，TUI `src/tui/interactions/` 消费） |
|---|---|
| `session.setApprovalHandler(fn)` | `session.approvals.onDidChangePending(...)` → `list()` → `decide(id, response)` |
| `session.setQuestionHandler(fn)` | `session.questions.onDidChangePending(...)` → `list()` → `answer(id, result)` / `dismiss(id)` |

`ApprovalResponse` / `QuestionResult` 结构 v1/v2 一致。pending 队列天然支持并发审批排队。

### 5.3 服务挂靠跟随 v2 scope

v2 的服务归属与 v1 不同，门面方法挂靠**跟随 v2 scope，不迁就 v1 习惯**：

| 能力 | v1 | v2（门面挂靠） |
|---|---|---|
| 插件管理（list/install/enable/remove/reload/info/listPluginCommands） | `Session` | `CoreHarness`（`IPluginService` 是 App 级） |
| `getStatus` | client 端 6-RPC 聚合 | 各 Agent 原生服务聚合（profile / permission / plan / swarm / contextSize / usage） |
| `reloadSession` | `Session` 方法 | `CoreHarness.reloadSession()`（需重建 CoreSession 实例） |

### 5.4 agent 路由显式化

| v1 | v2 |
|---|---|
| `harness.withInteractiveAgent(agentId, () => session.prompt(parts))` | `session.prompt(parts, { agentId })` |
| `harness.interactiveAgentId`（AsyncLocalStorage） | TUI 自持 `interactiveAgentId` 字段，默认 `'main'` |

### 5.5 其他

| v1 | v2 |
|---|---|
| `session.init()`（`/init`） | `session.generateAgentsMd()` |
| `SessionSummary.workDir`（来自 v1 index） | `CoreSessionSummary.workDir`（来自 v2 index 的 `cwd` 字段，投影命名保持 `workDir`） |
| `getConfigDiagnostics()` 返回 `{ warnings }` | 返回 `readonly ConfigDiagnostic[]`（按 `severity` 过滤 warning/error） |
| `onEvent` 返回 `IDisposable` | 返回退订函数 `() => void` |

## 6. 缺口清单（`TODO(v2-gap)`）

v2 一行不改，缺失能力降级 + 标记。完整清单与设计文档 §7 对账：

| 编号 | 缺口 | 降级行为 |
|---|---|---|
| G-3 | bootstrap 无 `skillDirs` 输入 | 参数接受并忽略（`harness.ts:94,160`） |
| G-4 | 无退出 drain API | close 时 best-effort（`harness.ts:477`） |
| G-5 | `forcePluginSessionStartReminder` 无 API | reload 接受并忽略（`harness.ts:131,268`） |
| G-8 | create/resume 无 additionalDirs 输入、注入不持久 | 物化后立即注入，仅存活于 session scope（`harness.ts:223,500`） |
| G-9/G-12 | 无 warnings 聚合 API；AGENTS.md warning 仅缓存 | 仅回 profile 缓存的 AGENTS.md warning（`session.ts:341`） |
| G-11 | config 无 raw 文本投影 | `raw` 省略（`harness.ts:384`） |
| G-20 | question origin 无 agentId | 子 agent 提问归因 main（`session.ts:592`） |
| G-30 | resume 无 warning 通道 | `warning: undefined`（`harness.ts:511`） |

实现期新增未编号 gap（设计 §7 之后发现，方向合理）：

- v2 无 per-agent `ProviderConfig` DTO → resume 回放的 `provider?.model` 恒 undefined（`replay.ts:66`、`types.ts:173`）。
- `/export-md` 的 `token_count` best-effort 填 0（`commands/session.ts:119`）。

## 7. 临时桥接（`TODO(migrate)`）

下列依赖项计划在后续 follow-up 中搬离或替换为 v2/protocol 正式导出：

| 位置 | 内容 | 去向 |
|---|---|---|
| `auth.ts` | `KimiAuthFacade`（与 RPC 解耦，直接操作 config 文件 + oauth 包） | 搬进 `src/core/`，直接依赖 `@moonshot-ai/kimi-code-oauth` |
| `catalog.ts` | catalog 纯函数（`effectiveModelAlias` / `fetchCatalog` 等） | v2 `IModelCatalogService` / `IModelService` 或本地化 |
| `types.ts` | `BackgroundTaskInfo` / `SessionUsage` 别名 | v2 原生类型 |
| `types.ts` | `McpServerStatusEvent` / `McpServerStatusPayload` / `McpOAuthAuthorizationUrlUpdateData` / `MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE` | `@moonshot-ai/protocol` 正式导出 |
| `src/utils/image-model.ts` | 图片压缩纯函数（`compressImageForModel` 等） | 已在 app 内，长期保留 |

入口链残留 SDK（`run-shell.ts` 的 `log`、`telemetry.ts`、`startup-error.ts`）属入口/server 共用区，随 auth migrate 一并处理。

## 8. 维护指南

### 8.1 加一个新的 session 方法

1. 在 v2 找到对应服务（`packages/agent-core-v2/src/...`），确认它属于 App / Session / Agent 哪一层 scope。
2. 在 `session.ts` 的 `CoreSession` 类加方法，内部 `this.agent(agentId).then(a => a.accessor.get(IXxxService).method(...))`。
3. 若返回类型是 v2 原生且 TUI 需要，在 `types.ts` 追加类型别名或在 `index.ts` re-export。
4. 在 `test/core/session.test.ts` 加用例（token 分发假件模式参考既有用例）。
5. TUI 调用点 import 类型自 `#/core/index`。

### 8.2 加一个新的 App 级方法

同上，但加在 `harness.ts` 的 `CoreHarness`，从 `this.deps.app.accessor.get(IXxxService)` 取服务。

### 8.3 加一个新事件

v2 事件 kind 自动经 `events.ts` 合流透传。若 TUI 需要处理新 kind：

1. 在 `session-event-handler.ts` 的 `handleEvent` switch 加 case。
2. 若事件 payload 需要补字段或来自 App 级总线（如 `session.meta.updated`），在 `events.ts` 加投影逻辑 + 单测。
3. 事件类型从 `#/core/index` re-export（v2 barrel 有就直接转口）。

### 8.4 加一种新的交互 kind

v2 的 `ISessionInteractionService` 当前有 `approval` / `question` / `user_tool` 三种 kind。门面只透传前两种。若需要支持 `user_tool` 或新增 kind，在 `session.ts` 的 `buildApprovals`/`buildQuestions` 旁加对应的子对象 + `src/tui/interactions/` 控制器。

### 8.5 排错路径

TUI 行为异常时按数据流反查：

- **交互问题**（审批/提问不弹、卡死）→ `interactions/` 控制器（in-flight 去重 / decide 写回 / 异常 settle）→ `session.ts` 的 `approvals`/`questions` 投影 → v2 `ISessionInteractionService`。
- **事件问题**（流式不更新、subagent 事件丢失）→ `session-event-handler.ts` case → `events.ts` 合流（订阅覆盖 / flush 队列 / App 级总线）→ v2 各服务的 `IEventBus.publish`。
- **方法行为偏差** → `session.ts`/`harness.ts` 对应域方法 → v2 服务实现。
- **resume 回放缺失** → `replay.ts` 的 `buildResumedAgents` → 各 v2 服务的数据形状。

## 9. 验证命令

切换涉及的所有验证（一律用干净 env，避免本机 `KIMI_CODE_EXPERIMENTAL_FLAG` 把 print 测试切到 v2 撞 minidb 锁）：

```bash
# 全量测试
env -u KIMI_CODE_EXPERIMENTAL_FLAG pnpm -C apps/kimi-code exec vitest run

# typecheck（仅 v2 包 sessionMetadata.ts 的 6 条预存错误为基线）
pnpm -C apps/kimi-code exec tsc -p tsconfig.json --noEmit

# 构建 + 冒烟
pnpm -C apps/kimi-code run build && node apps/kimi-code/scripts/smoke.mjs

# 不动区零 diff
git diff --stat packages/ apps/kimi-code/src/cli/v2

# 缺口对账
grep -rn "TODO(v2-gap)\|TODO(migrate)" apps/kimi-code/src/core apps/kimi-code/src/tui

# SDK 残留审计（src/tui 应零命中）
grep -rn "@moonshot-ai/kimi-code-sdk" apps/kimi-code/src/tui
```

## 10. 端到端 dogfood 清单

单元测试用 fake scope / broker，以下是**真实 v2 引擎**端到端验证前的高风险点（按风险排序）：

1. **审批/提问面板 + 排队**：manual 模式触发审批；连发多个需审批工具验证排队；`Approve for session` 后同 action 自动通过；`AskUserQuestion` 触发提问 + Esc dismiss；policy 自动批准某工具确认不弹面板且不卡 turn。
2. **流式渲染**：长文本 + thinking + 工具调用的 prompt，确认 live 文本、工具卡片、thinking 实时更新。
3. **resume 回放保真**：含工具调用 + thinking + `!` shell + subagent + goal 的会话 `kimi -r` resume，确认回放渲染消息且不崩。
4. **`/btw`**：开 /btw 提问，确认子 agent 响应渲染在 btw 面板；关闭后 agentId 回 main。
5. **`!` shell + compaction 回放**：`!ls` 看实时输出；`!sleep 30` 取消；压缩后 resume 确认压缩前的 user/assistant/tool 消息全量在、shell 输出渲染为 `$ cmd` + 输出块、compaction 显示为带 token 数的折叠卡片。
6. **后台任务面板**：spawn 长任务，开 tasks browser，stop/detach。
7. **图片粘贴**：向 image-capable 模型粘贴图片，确认模型看到；测压缩 caption。
8. **坏 config fail-fast**：写坏 TOML 到 config.toml，启动应打印 `Config error [domain]: …` 并 `exit 1`；warning-only config 应启动并带 startupNotice。
9. **Goal**：`/goal start/pause/resume/cancel`，验证 goal 面板与 queued-goal 提升流程。
10. **插件命令 / fork / rename / export**：install/enable/disable/remove 插件 + `/reload`；idle fork 成功、活跃 turn fork 报 `SESSION_FORK_ACTIVE_TURN`；rename 后 picker 标题更新；export markdown + debug zip。

## 11. 回滚

本切换是纯工作区改动（未 commit）。如需回滚：

```bash
git checkout -- apps/kimi-code AGENTS.md
rm -rf apps/kimi-code/src/core apps/kimi-code/test/core
rm -rf apps/kimi-code/src/tui/interactions
rm -f  apps/kimi-code/src/utils/image-model.ts
# reverse-rpc 目录经 git 恢复
git checkout -- apps/kimi-code/src/tui/reverse-rpc
```

回滚后 TUI 回到 v1 SDK 路径。print / ACP / 其他子命令始终未动，无需回滚。
