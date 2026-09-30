# ptc：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/ptc/`（约 541 行：tool.ts 193 / bridge.ts 134 / context.ts 123 / feature.ts 63 / catalog.ts 24 / code.md 7 / index.ts 4）
- agent-core-v2：**无对应功能**。已在 `packages/agent-core-v2/src` 全量检索实证：`programmatic` / `\bptc\b|\bPTC\b` / `orchestrat` / `code_mode|codemode|CodeMode` / `allowed_callers` / `name: 'Code'` 均无命中（唯一「CodeMode」命中为 `fetchManagedKimiCodeModels` 的子串误报，「orchestration」命中为 tower 工具文案，均无关）。
- 蓝本关系：无 v2 蓝本——PTC（Programmatic Tool Calling）是 **feat-274 新增的 Feature**（2026-09-29 三提交 `mkvsrzwz` 落地 → `wxvtkwot` context 分级 → `skswolxp` 防抖，经 feat-271 第 15 轮并入本工作区），其设计权威记录是 `.handoff/archived/feat-274-09-29-ptc.md`。本文以「新增 Feature 自述 + 与 v2 最接近机制的概念对比」替代逐项差异。

## 功能概述（v2 不存在的能力）

`createPtc(props)` 在 agent slot 注册单个 meta-tool **`Code`**：模型写一段 JavaScript（成为 async function body），经 `await tools.<name>(args)` 编排当前 agent 上已注册的工具；中间工具结果只是沙箱内 JS 值、**不进 history**，只有 Code 自身的 ToolResult（`stdout:` 尾部截断 + `return:` JSON 截断 / `error:` 摘要）回模型。执行形态为临时目录（`props.dir/<agentId>-run-N/`）写 `tools.mjs` shim + `program.mjs`，经 file URL **dynamic import 进程内执行**（bridge.ts:80-120）；bridge 经 `globalThis.__ptc_bridge_registry__` 传递。

关键机制：
- **可调面**：`Proxy` 动态分发（tool.ts:71-87）——任意已注册 executor 凭名可调（含 deferred、executor-only、冻结 spec 后注册的）；`PtcPolicy` 落为 props `exclude` 黑名单（目录与调用两侧生效），`Code` 自身永排除防递归；unknown 名抛 `unknown tool: <name>`，被排除抛 `tool '<name>' is not callable from Code`。
- **钩子链**：沙箱内每次调用手跑 `ports.beforeTools`（denied 短路返回、proceed 改写链式传递）→ `ports.resolveToolExecutor(name).execute` → `ports.afterTools`（tool.ts:116-156），蓝本为 `bindToolLogic`；结果文本化（多 part 拼接、非文本 part 占位 `(image/audio/video omitted…)`）。
- **护栏**：`maxToolCalls` 50（unknown/被排除调用也消耗计数——「尝试次数」语义）/ `maxOutputBytes` 32768（stdout 滚动保留尾部、成功路径 `truncate` 附 `(stdout truncated to last N chars)`）/ `timeoutMs` 120s（AbortController 联动工具机 signal，超时 `Code execution timed out after Nms`）。
- **目录**：`renderCatalog` 把 `ports.toolDescriptions` 渲染为预算化（8000 字符）TS 签名目录嵌进工具描述，超出者附 `({N} more tools available but omitted…)` 句；挂载时静态渲染（spec freeze 语义下后注册工具不在目录——docs 写明「宿主应把 ptc 排在名单末尾」）。
- **detach**：`detach(text)` 暴露进沙箱 API，整段编排可转后台（完成走机器既有 async-tool 通知）。
- **context 三级**（`props.context`，默认 `'none'`）：`'readonly'` 暴露 `useAgent/useAgentStore/useBlobs/useSession` 裁剪面（getState 快照读、on/wait、 blobs get/has、session stores/list/get）；`'full'` 给裸 facade（store.dispatch、blobs.put、agent.remind/notify/submit/run/abortTool 等命令面）；订阅经 `drain()` 按执行统一退订。
- **flag 门控**：`KIMI_CODE_EXPERIMENTAL_PTC` 或 `KIMI_CODE_EXPERIMENTAL_FLAG`（'true'/'1'），默认不进 preset；`props.enabled` 可覆盖。

## 与 v2 最接近机制的概念对比

| PTC 概念 | v2 最接近物 | 关系 |
|---|---|---|
| 模型写代码编排工具 | v2 **无任何对应物**（codex `code_mode` / opencode `codemode` 为外部参照，见 feat-274 调研） | 全新能力 |
| 沙箱内手跑钩子链 | v2 `toolExecutor` 的 `onBeforeExecuteTool` veto / `onDidExecuteTool` 钩子（toolHooks） | 语义同构：v2 所有工具调用必经该链；PTC 在新架构手跑 `beforeTools/afterTools` 保持 veto/改写语义（btw 的 deny 不被绕过） |
| 任意代码执行通道 | v2 Bash 工具（真实 shell 环境） | 并存不合并（feat-274 用户定）：Code 的价值是省模型往返 + 中间结果不进上下文，Bash 的价值是真实 shell |
| deferred/executor-only 工具可调 | v2 工具注册表（toolRegistry + registerAgentToolService） | PTC 经 `resolveToolExecutor` live map 调全量 executor，对应 v2「注册即可调」；新架构 spec freeze 只冻结描述不冻结执行 |

## 行为差异（相对 feat-274 契约的现状态）

### 人为设计
| 差异点 | 说明 | 依据 |
|---|---|---|
| 进程内 dynamic import 执行（无沙箱隔离） | 模型代码在 CLI 进程内跑，可访问全部 Node 模块；风险定性与 Bash 同级，flag 门控默认不开 | feat-274 用户 2026-09-29 批准；**DEBT-1**（`.debt/feat-274-09-29-ptc.md`）：去 flag 默认开启前必须升级为 worker_threads/独立进程隔离 |
| 可调面默认全开放 + `exclude` 黑名单 | 备选「默认空、白名单 opt-in」被用户否决（过保守则第一版基本不会用） | feat-274 约束问答① |
| `exclude` 黑名单落为 props 而非 collection | handoff 允许的最小形态（若做 collection 则 `usePtcPolicy`） | feat-274 第 1 轮偏差③ |
| 静态目录（挂载时渲染） | spec freeze 下目录反映冻结时工具集；动态目录（`useMessageResolver` 每请求重写，tool-select 先例）列为二期 | feat-274 第 1 轮偏差② |
| context 访问为「execute 期取回 setup 捕获的 facade」 | `use*()` 非贡献注册；`fold` 不可用（execute 期无 `currentUnit`），状态读用 `getState()` 快照 | feat-274 第 2 轮偏差① |
| context bridge 每次执行新建 | 防止订阅跨执行泄漏；disposers 按执行隔离 + `drain()` | feat-274 第 2 轮偏差② |

### 简化 / 保真度损失（含与 274 契约意图的现存缺口）
| 差异点 | 现状 | 影响与后续归属 |
|---|---|---|
| **`toolPermissions` 裁决阶段被沙箱绕过** | 274 契约明示「沙箱内工具调用走 beforeTools/afterTools 钩子链，保持 veto/改写语义（btw 的 deny、**未来 permission 审批不被绕过**）」；但 permission 域（271 第 29 轮）落地为**独立注册表** `ports.toolPermissions`（beforeTools→permission→execute 三阶段），PTC shim 只手跑 `beforeTools`/`afterTools` 两个数组（tool.ts:138-154），permission 策略链（危险命令/敏感文件/用户规则/ask 审批）对 Code 内部调用**完全不生效** | 与 274 契约意图不符的现存缺口（274 落地时 permission 贡献点尚不存在，此后未适配）；修复方向 = shim 在 beforeTools 后增跑 `ports.toolPermissions`（同 `bindAgentLogics.onBeforeTools` 两阶段语义），未立项 |
| **批级守卫（`useBeforeToolBatch`）被沙箱绕过** | 第 40 轮批级/per-call 分离后，swarm 独占守卫迁至 `beforeToolBatches`（turn 机 preflight 阶段跑）；PTC shim 无批概念、不跑该注册表 | 批级守卫对 Code 内调用不生效（如 AgentSwarm 可经 Code 绕过独占约束——但 Code 调 Agent/AgentSwarm 本身仍受各工具自身校验）；属同一 shim 适配缺口 |
| 模型代码内同步死循环无法抢占 | 进程内执行，同步 while(true) 只能等事件循环让出 | feat-274 记录在案，随 DEBT-1 worker 隔离一并解决 |
| 临时文件不清理 | 每次执行写 `<dir>/<agentId>-run-N/{tools.mjs,program.mjs}`，跑完不删（bridge 注册表条目有删） | dir 由宿主注入（session 级 scratch 定位），清理责任未明；未立项 |
| 二期项未动 | resolver 动态目录、`tools.search()`（deferred 工具池打分搜索）、`store/load` 跨执行显式 API、trace 遥测 | feat-274「已识别的二期项」清单，274 已归档、项保持 open |

### 新增 / 更强（相对 v2 全体）
| 差异点 | 说明 |
|---|---|
| 代码编排能力本身 | 见「功能概述」；v2 全域无对应 |
| `detach(text)` 沙箱 API | 模型可主动把整段编排转后台，完成走机器 async-tool 通知；v2 无 meta-tool 概念 |
| context 三级 facade 访问 | 模型代码可按 Feature 开发语义读写 agent 上下文（274 第 2 轮用户提出）；`'full'` 级裸 facade 不走 `beforeTools` 策略链——274 已写入 docs 并补记进 DEBT-1 解决条件 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| experimental flag | 无 | `KIMI_CODE_EXPERIMENTAL_PTC` / `KIMI_CODE_EXPERIMENTAL_FLAG`（'true'/'1'），默认关、不进 preset | 新增（feat-274 用户定，与 codex/opencode experimental 做法一致） |
| 工厂 props | 无 | `createPtc({ dir, exclude?, limits?, context?, enabled? })`：`dir` 宿主注入的产物目录端口（必需）；`limits` 三护栏可部分覆盖 | 新增（宿主端口范式，对齐 `createConfig({persist})`） |
| config 节 / env 绑定 | 无 | 无（flag env 之外无配置面） | — |
| 工具描述 | 无 | code.md 静态 + Context access 段（按级别）+ 预算化目录（8000 字符） | 新增 |

## 工具 / 事件 / facade 面差异
- 工具：`Code`（参数 `{code: string}` required；输出 `stdout:`/`return:`/`error:`/`(no output)` 四形态）——v2 无。
- Feature 事件：无。facade：无（PTC 不暴露 `useExpose` token；能力全部经工具与 props 进入）。
- 271 后续轮次的适配记录：第 27 轮 `createFullAgent` 补 `abortTool` 转发、第 36 轮补 `run` 转发（typecheck 实证手写包装随 `AgentCommands` 扩展编译报错、无遗漏面）；第 37 轮 shim 手跑钩子曾补 `toolCalls` 实参、第 40 轮随 `ToolBeforeInput` 收窄删除（批保持改写前原值对齐机器语义）。

## 摘要
PTC 在 v2 中完全不存在，是 feat-274 基于 271 已落地的贡献面（registerToolExecutor / resolveToolExecutor / deferred / detach / useBlobs）零 agent-core 改动新增的 experimental Feature；v2 侧最接近的机制是 toolExecutor 的 before/after 钩子链与 Bash 工具，PTC 与两者分别保持「钩子语义同构」与「并存不合并」的关系。当前最重要的问题不是与 v2 的差异而是与自身契约的偏差：274 明示「未来 permission 审批不被绕过」，但 permission 落地为独立 `toolPermissions` 注册表后 shim 未适配（连同第 40 轮的批级守卫一起被沙箱绕过），Code 内部调用目前只有 beforeTools 级领域守卫生效。其次是 DEBT-1 进程内隔离（去 flag 前必须升级为 worker/独立进程，届时 context 分级需按 RPC 形态重估）与四个二期项（动态目录、tools.search、store/load、trace 遥测）保持 open。
