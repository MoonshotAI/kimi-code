# 产品 Feature 一览

`src/preset.ts` 的 `features` 是默认名单；工厂形态的 Feature 由宿主组装后推进名单（参照 [01](how-to-guides/01-run-a-turn.md) 与 [07](how-to-guides/07-use-provider-catalog.md) 的装配方式）。本页按 Feature 给出：规格名、所在层、props、facade、事件、是否在默认名单。

## spawn（工厂，不在默认名单）

`createSpawn(props?)`：把 `Agent` 工具装到每个 agent 上，模型调用它派生子代理。

- props：`catalog?`（profile 目录，默认 `builtinSpawnCatalog` 含 coder/explore；宿主替换以定义 profile 从哪里来）、`models?`（工具描述里列出的可选模型）、`forkEnabled?`（默认读 `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK`）。
- 工具参数：`prompt` / `description` / `subagent_type`（默认 `coder`）/ `resume` / `run_in_background` / `fork`（flag 门控）/ `model`（`'primary'` 继承调用方）。
- 行为：校验（静态互斥 + planSpawn 白名单/profile/模型）→ `session.create` / `session.fork` 建子代理 → `submit` 等终态 → 取子代理最后一条 assistant 文本作交接摘要。后台走 `detach`，完成经 async-tool 通知回父代理。fork 复制调用方完整历史并注入 `FORK_CONTEXT_NOTICE`。resume 只接当前进程内 live 的子代理。
- 事件（`createFeature<SpawnEvent>`，宿主 `session.on(spawn, type)` 订阅）：`subagent.spawned` / `subagent.completed` / `subagent.failed` / `subagent.cancelled`。
- facade：`SpawnRegistryRef`（session 层 registry，`handle.resolve(SpawnRegistryRef)`）。
- 注意：工具描述是静态的（agent spec 首包冻结，见 [store-model](../explanation/store-model.md)），可选模型列表只来自 props `models`，不读调用方 config。

## btw（默认名单）

`createBtw(props?)`：旁路问题。从 main（默认）fork 一个只读子代理，等宿主把用户的旁路问题直接提交给它。

- props：`sourceAgentId?`（默认 `MAIN_AGENT_ID`）、`readonlyTools?`（只读工具白名单，默认 `['Read', 'Grep', 'Glob', 'WaitFor']`）。
- facade：`BtwRef`（`session.resolve(BtwRef)`）：`ask(): Promise<{ agentId }>` 做 fork（把 `source: 'btw'` 登记进 roster）+ 注入旁路 reminder；`list()` / `isBtw(agentId)` 从 roster 的 `source` 字段派生，remount 与 undo/compaction 换分支（`agent.switched` 保留 source）后仍然成立。
- 约束：btw agent 上白名单外的工具调用一律 denied（`useBeforeTool` 查 roster `source`），main 与其它 agent 不受影响。
- 事件：`btw.created`（`agentId` / `sourceId`）。

## dateChange（默认名单）

`createDateChange(props?)`：跨天注入新日期。每个 LLM step 前（`useBeforeStep`）比较本地日期，变了就 `agent.remind('date-change', …)`（同 key 覆盖，首次与跨天文案不同）；remount 后从历史扫描已注入记录，同天不重复。

- props：`now?`（时钟注入，测试用）、`timeZone?`（默认宿主时区）。
- 无 facade、无事件。

## 已有 Feature 速查

| Feature | 形态 | 层 | 默认名单 |
|---|---|---|---|
| providerCatalog / waitFor（agent-core builtin） | spec | app / agent | 是 |
| todo / timing / usage / kimiTrace / kimi / interaction | spec | agent（interaction 双层） | 是 |
| createToolSelect / createCompaction / createMedia / createHttp | 工厂 | agent / app | 否 |
