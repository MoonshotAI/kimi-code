# Thinking 模型重构 — 测试覆盖审查报告

> PR #1132（分支 `support-effort`）的测试缺口分析。生成于 2026-06-26，供后续补测试用。
>
> 总体结论：**核心逻辑（resolveThinkingEffort、kimi/anthropic provider、ACP toggle、TUI commitEffort）覆盖较扎实；本次重构引入的若干"归一/兼容"分支存在行为契约未锁定的缺口。没有发现会导致运行时崩溃（P0）的缺口；所有缺口均为行为契约（P1）或 nice-to-have（P2）。**

---

## 两个待确认的设计问题

### 1. `default_thinking` / `thinking.mode` 是「拒绝」还是「静默忽略」？

- **当前实现**：静默忽略 + 下次写入时剥离（schema 非 strict，`packages/agent-core/src/config/toml.ts` 写入时 `delete out['mode']` / `delete out['default_thinking']`）。
- **计划意图**：「直接删除，不做兼容读取」，breaking change。
- **建议**：按"静默忽略 + 写入剥离"补测试锁定（P1 第 4 项）。如果要 fail-fast，需把 schema 改为 `.strict()` 并补 fail-fast 测试。

### 2. `commitEffort('on')` 当 `defaultEffort` 不在 `supportEfforts` 内时返回 `defaultEffort`，是否有意？

- **当前实现**：`defaultThinkingEffortFor`（agent-core 和 TUI 内联）都是 `model.defaultEffort ?? middleOf(supportEfforts)`，**不校验 `defaultEffort` 是否在 `supportEfforts` 内**。
- **为什么合理**：provider 端会归一（声明外的 effort 不下发 wire effort），所以即使 `defaultEffort` 不在声明里也不会导致 wire 错误。
- **建议**：按"返回 defaultEffort，由 provider 归一"补测试锁定（P1 第 12 项）。

---

## P1 缺口（行为契约未锁定，建议本 PR 或 follow-up 尽快补）

### kosong

#### `openai-common.ts` — `thinkingEffortToReasoningEffort`
- **现有**：`off/low/medium/high/xhigh/max` + 未知 `'extreme'` → undefined（`openai-common-errors.test.ts:314-337`）。
- **缺口**：`'on'` 没有显式断言（注释明确把 `'on'` 列为归一对象，但测试用 `'extreme'`）。
- **建议**：把 `it('normalizes unknown effort to undefined')` 改成 `it.each(['on', 'extreme', 'foo'])`。

#### `anthropic.ts` — `clampEffort`
- **现有**：xhigh/max 在 opus-4-5/4-6/4-7/4-8/fable/sonnet/haiku 上的 clamp 与透传、adaptive vs budget、`off`、low/medium 透传（`anthropic.test.ts:1084-1400`）。
- **缺口**：`'on'` / 未知 effort（如 `'foo'`）→ clamp 到 `'high'`（`anthropic.ts:342-350` 的最后 if 分支）**完全未覆盖**。
- **建议**：`it.each(['on', 'foo'])` 在 adaptive 模型（如 `claude-opus-4-7`）上 → `output_config={effort:'high'}`；在非 adaptive 模型（如 `claude-sonnet-4-5`）上 → `thinking={type:'enabled',budget_tokens:32000}` 且无 `output_config`。

#### `google-genai.ts` — `withThinking`
- **现有**：非 gemini-3 的 `high`/`off`；gemini-3 的 `off/low/medium/high`；getter 反射（`google-genai.test.ts:729-836`）。
- **缺口**：
  - `'on'` / 未知 effort（`'foo'`）在 **gemini-3** 上 → 只 `include_thoughts:true`、不设 `thinking_level`（`google-genai.ts:829-852`）。未覆盖。
  - `'on'` / 未知 effort 在 **非 gemini-3** 上 → 只 `include_thoughts:true`、不设 `thinking_budget`（`google-genai.ts:853-873`）。未覆盖。
  - `'xhigh'`/`'max'` 在 **gemini-3** → `HIGH`（fall-through）。未覆盖。
- **建议**：`it.each(['on','foo'])` 在 `gemini-3-pro-preview` 上 → `thinking_config={include_thoughts:true}`（无 `thinking_level`）；在 `gemini-2.5-flash` 上 → `{include_thoughts:true}`（无 `thinking_budget`）。`it.each(['xhigh','max'])` 在 gemini-3 上 → `thinking_level:'HIGH'`。

#### `kimi.ts` — `withThinking`
- **现有**：非 effort 模型 / effort 模型 / `max` / `off` / `xhigh`/`on`/`foo` 不在 supportEfforts / getter / 重复调用（`kimi.test.ts:708-799`）。
- **缺口**：空 `supportEfforts: []`（与 `undefined` 等价）未显式覆盖。
- **建议**：加 `createProvider(false, []).withThinking('high')` → `thinking={type:'enabled'}`、无 `reasoning_effort`。

### agent-core

#### `config/schema.ts` — 删除 `default_thinking` / `thinking.mode`
- **现有**：`[thinking] enabled/effort` 解析；patch merge thinking；`default_yolo` 的 drop-deprecated 范式（`configs.test.ts`）。
- **缺口**：`default_thinking`（顶层）被忽略/剥离**无测试**；`thinking.mode` 被忽略/剥离**无测试**。
- **建议**：`parseConfigString('default_thinking = true\n[thinking]\nmode = "always"\neffort="high"\n')` → `config.thinking` 不含 `mode`、顶层无 `defaultThinking`，且 `writeConfigFile` 后文本不含 `default_thinking` / `mode`。

#### `config/env-model.ts` — 删除 `KIMI_MODEL_THINKING_MODE` / `KIMI_MODEL_DEFAULT_THINKING`
- **现有**：`KIMI_MODEL_THINKING_EFFORT` 映射；`KIMI_MODEL_ADAPTIVE_THINKING`；write-back 隔离（`env-model.test.ts`）。
- **缺口**：`KIMI_MODEL_THINKING_MODE` / `KIMI_MODEL_DEFAULT_THINKING` 被忽略**无测试**（回归保护，防止未来被误加回）。
- **建议**：`applyEnvModelConfig(MIN, { KIMI_MODEL_THINKING_MODE:'always', KIMI_MODEL_DEFAULT_THINKING:'high' })` → `config.thinking` 为 `undefined`（或不含 effort/mode）。

#### `agent/config/index.ts` — `update()` clamp 集成
- **现有**：always_thinking `'off'`→`'on'`；provider 构建 enabled；toggleable `'off'` 保持；切到 always_thinking re-clamp 旧 `'off'`（`config-state.test.ts:163-228`）。
- **缺口**：`modelAlias` 变化 + 旧 effort=`'off'` + 新 always_thinking 模型 + `config.effort='max'` → 应 clamp 到 `'max'`（而非 `defaultEffort`）。`update()` 在 modelAlias 分支把 `this._thinkingEffort` 作为 requested 传入，clamp 时读 `config?.effort`——这条路径未在 ConfigState 集成层测。
- **建议**：先 `update({modelAlias: toggleable, thinkingEffort:'off'})`，再 `update({modelAlias: deep})` 且 kimiConfig 带 `thinking:{effort:'max'}` → 期望 `'max'`。

#### `session/provider-manager.ts` — `supportEfforts` 透传给 kimi provider
- **现有**：无直接测试。kimi provider 单元覆盖了 supportEfforts 行为，但**接线层**（provider-manager 把 supportEfforts 写进 kimi provider config）未测。
- **缺口**：effort-capable alias 经 `ProviderManager.resolveProviderConfig` → kimi `ProviderConfig` 应携带 `supportEfforts`。
- **建议**：构造 `supportEfforts:['low','high','max']` 的 kimi alias，断言 `resolveProviderConfig(...).provider` 的 supportEfforts 透传（或经 `config.provider.thinkingEffort`/`modelParameters` 验证）。

### acp-adapter

#### `server.ts` — `resolveCurrentThinkingEnabled`
- **现有**：无直接测试。仅经 `newSession` 间接走 `getConfig` 无 `thinking` 字段 → `false` 分支。
- **缺口**（全 P1）：
  - `getConfig` 缺失（partial stub）→ `false`
  - `thinking.enabled === true` → `true`；`=== false` → `false`
  - `thinking.effort` 为非空 string（无 `enabled`）→ `true`（**本次新增核心分支**）
  - `getConfig` 抛错 → `false`
  - `thinking` 缺失 / `effort:''` → `false`
- **建议**：抽一个可直接调用 `resolveCurrentThinkingEnabled` 的测试（或经 `newSession` + 不同 `getConfig` 返回值断言 `configOptions.thinking.currentValue`），覆盖以上 5 条。

#### `server.ts` — `setupSessionFromExisting` resumedThinkingEffort 投影
- **现有**：`thinkingEffort='high'` → toggle `on`（`session-resume.test.ts:142-189`）。
- **缺口**：`thinkingEffort='off'` → `currentValue='off'` 未测；`thinkingEffort=''`（空串）→ `off` 未测。
- **建议**：加 `thinkingEffort:'off'` 与 `thinkingEffort:''` 两条，断言 `thinking.currentValue==='off'`。

#### `session.ts` — `thinkingOnEffort`
- **现有**：默认返回 `'on'`（fixture model 无 `supportEfforts`/`defaultEffort`）。
- **缺口**：effort-capable model（`defaultEffort='high'` 或 middle `supportEfforts`）→ 返回对应 effort，而非 `'on'`；`harness` 缺失（`undefined`）→ `'on'`。
- **建议**：`makeHarness` 加 effort-capable model（`supportEfforts:['low','high','max']`、`defaultEffort:'high'`），断言 `setThinkingCalls` 收到 `'high'`；另加无 harness 的 `AcpSession.setThinking(true)` → `'on'`。

### apps/kimi-code（TUI）

#### `tui/utils/thinking-config.ts` — `thinkingEffortToConfig` / `isThinkingOn`
- **现有**：无直接单元测试。仅经 `cli/provider.test.ts` 与 `kimi-tui-message-flow.test.ts` 间接覆盖。
- **缺口**：`thinkingEffortToConfig('off')` → `{enabled:false}`；`('low')`→`{enabled:true,effort:'low'}`；`('on')`→`{enabled:true,effort:'on'}` 无直接单测。
- **建议**：新建 `test/tui/utils/thinking-config.test.ts`，对 `thinkingEffortToConfig` / `isThinkingOn` 做参数化断言。

#### `tui/components/dialogs/model-selector.ts` — `commitEffort`
- **现有**：`'on'`→effort 模型 `defaultEffort`；`'on'`→middle；`'on'`→boolean `'on'`（`model-selector.test.ts`）。
- **缺口**：`commitEffort('on')` 当 `defaultEffort` **不在** `supportEfforts` 内 → 返回 `defaultEffort`（即使模型未声明支持）。该行为与 agent-core 一致，但 TUI 层未锁定（见"待确认问题 2"）。
- **建议**：加 `effortModel(..., ['low','high'], 'max')` 非当前模型 → Enter → `onSelect` 收到 `thinking:'max'`（锁定现状）。

#### `tui/commands/config.ts` — `persistModelSelection` short-circuit
- **现有**：runtime 不变但 `defaultModel` 不同 → 仍写入；Alt+S 不持久化（`kimi-tui-message-flow.test.ts`）。
- **缺口**：`defaultModel`、`thinking.enabled`、`thinking.effort` **三者完全相同** → 返回 `false`、不调用 `setConfig`（short-circuit `config.ts:467-473`）。未直接测。
- **建议**：加一条 `getConfig` 返回 `defaultModel:'k2', thinking:{enabled:true,effort:'on'}`，选择 `k2` + `on` → `setConfig` 未被调用，且状态提示 "Already using ..."。

---

## P2 缺口（nice-to-have）

- `provider.ts`：type-level 开放字符串断言（`const e: ThinkingEffort = 'any-custom-effort'`）。
- `kimi.ts`：`keep` 字段在 `withThinking` 后保留（`withExtraBody({thinking:{keep}}).withThinking(...)`）。
- `anthropic.ts`：`budgetTokensForEffort` 对 `'off'/'xhigh'/'max'` 的 `throw` 分支（生产路径被 clampEffort 保护）。
- `google-genai.ts`：非 gemini-3 的 `low`/`medium`/`xhigh`/`max` budget 矩阵；gemini-3 getter 反射。
- `thinking.ts`：`defaultEffort` 不在 `supportEfforts` 内的语义命名；`requested='off'` + always_thinking ± `config.effort` 组合。
- `config-state.test.ts`：modelAlias 切换保留非 `'off'` effort；thinkingEffort + modelAlias 同时变化。
- `schema.ts`：`thinking.enabled` 非 boolean、`thinking.effort` 非 string → 报错的类型校验。
- `env-model.ts`：`KIMI_MODEL_THINKING_EFFORT` 与已有 `enabled` 的合并（base config 带 `thinking:{enabled:true}`，env 设 effort → `{enabled:true, effort}`）。
- `session-resume.test.ts`：`thinkingEffort` 大写/带空格；mainConfig 缺 `thinkingEffort` 的 fallback 断言。
- `session.ts` `thinkingOnEffort`：currentModelId 不在 catalog → `'on'`。
- `promptThinkingSchema`：非 string（如 `number`/`boolean`）→ 拒绝。
- `thinking-config.test.ts`：`isThinkingOn` 各分支。
- `commitEffort`：非 `'on'` draft 透传。
- `persistModelSelection`：defaultModel 相同但 effort 不同 → 写入。

---

## 建议的补充顺序

### 本 PR 内补（简单 + 高价值）
1. openai-common：`it.each(['on', 'extreme', 'foo'])` 显式含 `'on'`
2. anthropic `clampEffort`：`it.each(['on', 'foo'])` adaptive + budget 两条
3. schema：`default_thinking` / `thinking.mode` 静默忽略 + 写入剥离
4. env-model：`KIMI_MODEL_THINKING_MODE` / `KIMI_MODEL_DEFAULT_THINKING` 被忽略
5. ACP `resolveCurrentThinkingEnabled`：5 条分支
6. TUI `thinkingEffortToConfig`：直接单元测试（`off` / `on` / `low`）
7. kimi `withThinking`：空 `supportEfforts: []`
8. google-genai `withThinking`：`'on'` / 未知（gemini-3 + 非 gemini-3）

### follow-up（避免本 PR 继续膨胀）
- provider-manager `supportEfforts` 透传
- ConfigState.update() modelAlias 切换 + config.effort 集成
- ACP resume `thinkingEffort='off'` / `''`
- commitEffort defaultEffort 不在声明内
- persistModelSelection short-circuit
- 全部 P2
