# Thinking 模型重构方案

> 前置工作：`plan/thinking-effort-switching.md`（effort 多档切换）已完成。本方案是在其基础上对 thinking 模型的整体重构，目标是消除冗余开关、硬编码默认值和静态档位枚举，让 `support_efforts` 成为档位的唯一真相源。

## 1. 背景与目标

当前 thinking 的开关和级别逻辑横跨 config、agent-core、SDK、TUI、provider 五层，经过多轮演进后积累了以下问题：

- 配置层同时存在 `default_thinking`（boolean）、`thinking.mode`（auto/on/off）、`thinking.effort` 三个字段，语义重叠；`mode=auto` 与 `mode=on` 代码里完全等价，名存实亡。
- kosong 的 `ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'` 是全局硬编码枚举，但档位本应来自模型声明的 `support_efforts`；`kimiEffort()` 还得硬编码 `'xhigh' → 'high'` 之类的映射。
- `'on'` 是一个不在 `ThinkingEffort` 枚举里的幽灵档位，贯穿 TUI → SDK → agent-core，语义在层间断裂。
- TUI 用 `AppState.thinking: boolean` + `AppState.thinkingLevel?: string` 两个字段存一个状态，五处重复 fallback。
- `DEFAULT_THINKING_EFFORT = 'high'` 硬编码兜底，与模型声明的 `default_effort` 重复。
- `always_thinking` 约束在 UI、agent-core getter、acp adapter 三处各 clamp 一次。

目标：

1. 配置收敛到 `[thinking]` 一处，删除 `default_thinking` 和 `thinking.mode`。
2. `support_efforts` 成为 effort 档位的唯一真相源，删除全局 `ThinkingEffort` 枚举和 `kimiEffort` 映射。
3. 删除 `DEFAULT_THINKING_EFFORT` 硬编码，默认值完全由模型声明推导。
4. `'on'` 圈禁为 boolean 模型（无 `support_efforts`）专属的开启信号，不再贯穿全栈。
5. TUI 单一字段 `thinkingLevel`，删除 `thinking: boolean`。
6. `always_thinking` 约束集中到 agent-core resolve 一处。

非目标（本期不做）：

- 按模型分别记住 effort 偏好（`[thinking.model_efforts]`），仍用全局 `thinking.effort`，切模型时由 provider 归一。
- 真正实现 `mode=auto` 的"按任务/模型自适应"，直接删除该值。
- kimi-web 端改造。

## 2. 设计原则

1. **单一真值**：thinking 运行时状态在 agent-core 里就是一个 `ThinkingLevel`，不存在第二个 boolean 字段。
2. **`support_efforts` 是 effort 档位的唯一真相源**：档位是模型的属性，不是全局枚举。
3. **归一优先于校验**：不做 `isValidThinkingLevel` 严格校验抛错；非法 effort 在 provider 端宽容归一为 `undefined`。
4. **`'off'` 和 `'on'` 是唯二保留字**：`'off'` 关闭，`'on'` 专属于无 `support_efforts` 的 boolean 模型；其余档位都是模型声明。
5. **`always_thinking` 是约束，不是档位**：在 agent-core resolve 一处 clamp。

## 3. 设计决策（已确认）

| 决策点 | 结论 |
|---|---|
| `default_thinking` | **直接删除**，不做兼容读取。breaking change，changeset 走 major + changelog 写迁移说明 |
| `thinking.mode` | **删除**。`off` 由 `enabled=false` 表达，`on`/`auto` 由 `enabled=true` 表达 |
| `DEFAULT_THINKING_EFFORT = 'high'` | **删除**。默认值由 `defaultLevelFor(model)` 从模型声明推导 |
| `ThinkingEffort` 静态枚举 | **删除**。改为 `ThinkingLevel = 'off' | 'on' | (string & {})`，档位动态化 |
| `isValidThinkingLevel` 校验 | **不做**。非法 effort 在 provider 宽容归一为 `undefined`，不抛错 |
| effort 非法值归一 | provider 端：`supportEfforts.includes(level) ? level : undefined` |
| `always_thinking` clamp | agent-core `resolveThinkingLevel`：`level === 'off'` 时归一为 `defaultLevelFor(model)` |
| `kimiEffort()` 映射 | **删除**。effort 直接来自 `support_efforts`，是 kimi 原生值 |
| `wireEffortToThinkingEffort()` | **删除**。getter 直接读 wire 值 |
| TUI `AppState.thinking: boolean` | **删除**。只留 `thinkingLevel: ThinkingLevel` |
| `setThinking` 类型 | `ThinkingLevel`，透传无运行时校验 |
| 全局 effort 偏好 | 保留 `thinking.effort`，切模型时由 provider 归一（不合法则不带 effort） |

## 4. 目标形态

### 4.1 config.toml

```toml
default_model = "kimi-code/kimi-k2"

[thinking]
enabled = true      # 默认是否开启（替代 default_thinking + thinking.mode）
effort  = "high"    # 开启时的默认档位（low/medium/high/xhigh/max，或模型声明的其他档）

[models."kimi-code/kimi-k2"]
provider = "kimi-code"
model = "kimi-k2"
max_context_size = 262144
capabilities = ["thinking", "always_thinking", "tool_use"]
support_efforts = ["low", "high", "max"]   # effort 档的唯一真相源
default_effort = "high"
```

迁移说明（changelog）：旧配置 `default_thinking = true` 改为 `[thinking] enabled = true`；`default_thinking = false` 改为 `enabled = false`；`[thinking] mode = "off"` 改为 `enabled = false`；`mode = "on"` / `mode = "auto"` 删除该行（等价于 `enabled = true`）。

### 4.2 类型

```ts
// packages/kosong/src/provider.ts
export type ThinkingLevel = 'off' | 'on' | (string & {});
//                                            ^^^^^^^^^^^^
//                              模型声明的 effort 档，运行时 string
```

`ThinkingEffort` 类型**直接删除**，所有引用在同一个 PR 内全量替换为 `ThinkingLevel`，**不留别名、不留兼容层**。

`ThinkingLevel` 在 TS 里塌缩成 `string`，主要作为**语义标注**：告诉调用者这里应该是 `'off'` / `'on'` / 模型 effort 档。运行时就是 `string`，不做强约束。

### 4.3 agent-core 运行时

```ts
// packages/agent-core/src/agent/config/index.ts
private _thinkingLevel: ThinkingLevel = 'off';

get thinkingLevel(): ThinkingLevel {
  return this._thinkingLevel;     // 不在这里 clamp always_thinking
}
```

`_thinkingLevel` 是 agent-core 内唯一的 thinking 状态字段。

### 4.4 配置 schema

```ts
// packages/agent-core/src/config/schema.ts
export const ThinkingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effort: z.string().optional(),
});
```

删除 `mode` 字段。

### 4.5 provider 层

```ts
// packages/kosong/src/providers/kimi.ts
withThinking(level: ThinkingLevel): KimiChatProvider {
  let thinking: ThinkingConfig;
  let reasoningEffort: string | undefined;

  if (level === 'off') {
    thinking = { type: 'disabled' };
  } else {
    // support_efforts 是 effort 档的唯一真相源：只下发声明里的值，
    // 其余（'on' / 'xhigh' / 非法值）一律归一为 undefined（不带 effort）。
    const effort = this._supportEfforts.includes(level) ? level : undefined;
    thinking = effort !== undefined
      ? { type: 'enabled', effort }
      : { type: 'enabled' };
    // TODO: drop reasoning_effort once the new thinking.effort wire format is
    // fully rolled out across all kimi models.
    reasoningEffort = effort;
  }

  const oldExtra = this._generationKwargs.extra_body ?? {};
  const keep = oldExtra.thinking?.keep;
  if (keep !== undefined) {
    thinking = { ...thinking, keep };
  }
  return this._withGenerationKwargs({
    reasoning_effort: reasoningEffort,
    extra_body: { ...oldExtra, thinking },
  });
}
```

其它 provider（openai / anthropic / google-genai 等）的 `withThinking` 已经各自把 effort 映射到原生参数，本期不改。

### 4.6 TUI 层

```ts
// apps/kimi-code/src/tui/types.ts
AppState.thinkingLevel: ThinkingLevel;   // 唯一字段，删除 thinking: boolean
```

boolean 模型的 UI 归一：

```ts
// model-selector.ts
function commitLevel(choice: ModelChoice, draft: string): ThinkingLevel {
  if (draft === 'off') return 'off';
  if (draft === 'on') {
    return defaultLevelFor(choice.model);   // boolean 模型：On → 模型默认
  }
  return draft;
}
```

`ModelSelection.thinking` 类型收紧为 `ThinkingLevel`，不再有 `'on'` 漏出 UI 边界。

## 5. 关键归一规则

### 5.1 默认值推导

```ts
// packages/agent-core/src/agent/config/thinking.ts
function defaultLevelFor(model: ModelAlias): ThinkingLevel {
  if (!supportsThinking(model)) return 'off';
  const efforts = model.supportEfforts;
  if (efforts?.length) return model.defaultEffort ?? middleOf(efforts);
  return 'on';   // boolean 模型
}
```

| 模型 | 默认 |
|---|---|
| 不支持 thinking | `'off'` |
| 有 `support_efforts` | `default_effort` → `support_efforts` 中位 |
| 无 effort 的 boolean 模型 | `'on'` |

### 5.2 resolve

```ts
// packages/agent-core/src/agent/config/thinking.ts
export function resolveThinkingLevel(
  requested: ThinkingLevel | undefined,
  config: ThinkingConfig | undefined,
  model: ModelAlias,
): ThinkingLevel {
  let level: ThinkingLevel;

  if (requested !== undefined) {
    level = requested;
  } else if (config?.enabled === false) {
    level = 'off';
  } else {
    level = config?.effort ?? defaultLevelFor(model);
  }

  // always_thinking 模型强制开启：'off' 归一为默认档
  if (level === 'off' && model.capabilities?.includes('always_thinking')) {
    level = defaultLevelFor(model);
  }

  return level;
}
```

删除 `resolveThinkingEffort`、`'on'` 分支、`mode` 分支、`DEFAULT_THINKING_EFFORT`。

### 5.3 provider effort 归一

```ts
const effort = this._supportEfforts.includes(level) ? level : undefined;
```

行为表：

| 模型 | 传入 level | wire `thinking` |
|---|---|---|
| effort 模型 `['low','high','max']` | `'high'` | `{ type: 'enabled', effort: 'high' }` |
| effort 模型 | `'max'` | `{ type: 'enabled', effort: 'max' }` |
| effort 模型 | `'xhigh'` | `{ type: 'enabled' }`（不带 effort） |
| effort 模型 | `'on'` | `{ type: 'enabled' }` |
| effort 模型 | `'foo'` | `{ type: 'enabled' }` |
| boolean 模型（无 support_efforts） | `'on'` | `{ type: 'enabled' }` |
| 任意 | `'off'` | `{ type: 'disabled' }` |

### 5.4 配置写入

```ts
// apps/kimi-code/src/tui/utils/thinking-config.ts
export function thinkingLevelToConfig(level: ThinkingLevel): ThinkingConfigPatch {
  return level === 'off'
    ? { enabled: false }
    : { enabled: true, effort: level };
}
```

删除 `config.ts` / `provider.ts` 里两处重复的 `level !== 'on' && level !== 'off' ? level : undefined`。

## 6. 实施步骤（单个 PR）

所有改动合并成**一个 PR** 一次性完成，不留兼容层、不留别名、不留 TODO 债。PR 内按以下顺序执行（仅用于把控改动节奏，不是独立 PR）：

### 步骤 1：类型与 `'on'` 圈禁

目标：消除 `AppState.thinking` 双字段，把 `'on'` 圈禁在 UI 层。

- kosong 导出 `ThinkingLevel = 'off' | 'on' | (string & {})`，**直接删除 `ThinkingEffort`**，本 PR 内全量替换所有引用，不留别名。
- node-sdk `setThinking(level: ThinkingLevel)`：保留透传，不做运行时校验（按决策）。
- TUI 删 `AppState.thinking: boolean`，统一用 `thinkingLevel: ThinkingLevel`：
  - `types.ts` 改字段
  - `kimi-tui.ts` 删 `thinking` 初始化、`syncRuntimeState` 删 `thinking` 派生写入
  - `footer.ts` / `status-panel.ts` / `info.ts` 等从 `thinkingLevel` 派生显示
- `model-selector.ts` 提交前归一：`'on'` → `defaultLevelFor(model)`；`ModelSelection.thinking: ThinkingLevel`。
- 删 5 处 `thinkingLevel ?? (thinking ? 'on' : 'off')` fallback，抽 `isThinkingOn(level)` / `thinkingLabel(level)` helper。
- `prompts.ts` open-platform/catalog 路径：现在 `ModelSelection.thinking` 已是 `ThinkingLevel`，删除 `thinking !== 'off'` 转 boolean 的逻辑（按需调整返回类型）。

验证：现有测试通过；新增 `'on'` 归一、`isThinkingOn` helper 测试。

### 步骤 2：配置收敛

目标：删 `default_thinking` 和 `thinking.mode`，收敛到 `[thinking] { enabled, effort }`。

- `schema.ts` `ThinkingConfigSchema`：删 `mode`，`effort` 保持 `z.string().optional()`。
- `schema.ts` 顶层：删 `defaultThinking`（`KimiConfigSchema`）。
- `thinking.ts` `resolveThinkingLevel`：按 5.2 重写；删 `resolveThinkingEffort`、`'on'` 分支、`mode` 分支、`DEFAULT_THINKING_EFFORT`；新增 `defaultLevelFor`。
- `core-impl.ts` `createSession`：调用 `resolveThinkingLevel(options.thinking, config.thinking, model)`。
- TUI `persistModelSelection` / `setDefaultModel`：写入走 `thinkingLevelToConfig`，不再写 `defaultThinking`。
- `auth-flow.ts` `refreshConfigAfterLogin`：读 `config.thinking?.enabled` 替代 `config.defaultThinking`。
- `env-model.ts`：删 `KIMI_MODEL_THINKING_MODE` 处理（或改为设置 `enabled`）。
- 文档：`config-files.md` / `env-vars.md` 更新字段说明；changelog 写迁移说明。

验证：老 config.toml（含 `default_thinking`、`mode`）按 major 迁移说明手动改写后行为一致；新写入只产 `[thinking] enabled/effort`。

### 步骤 3：always_thinking 集中 + provider 归一

目标：删三处 clamp，删 `kimiEffort` / `wireEffortToThinkingEffort` 映射。

- `thinking.ts` `resolveThinkingLevel`：加 `always_thinking` clamp（在步骤 2 一并写入，本步骤验证 + 删其它 clamp）。
- `config/index.ts` `thinkingLevel` getter：删 `alwaysThinkingModel` clamp，直接返回 `_thinkingLevel`。
- `acp-adapter/session.ts` `setThinking`：删 `currentModelAlwaysThinking()` clamp；`THINKING_ON_LEVEL = 'high'` 改为 `defaultLevelFor(currentModel)` 或从 agent-core status 取。
- `kimi.ts` `withThinking`：按 4.5 重写；删 `kimiEffort()` 函数；`reasoning_effort` 双发本步骤保留，待服务端全量后在步骤 4 删除（唯一依赖服务端的收尾项）。
- `kimi.ts` `thinkingEffort` getter：删 `wireEffortToThinkingEffort()`，直接读 `thinking.effort`，无 effort 返回 `'on'`。
- UI `model-selector.ts` `renderThinkingControl`：保留 `Off (Unsupported)` 纯展示（不承担 clamp）。

验证：always_thinking 模型设 `'off'` 仍开启（agent-core clamp）；effort 模型传 `'xhigh'` / `'foo'` wire 不带 effort；`kimiEffort` / `wireEffortToThinkingEffort` 无引用。

### 步骤 4：清理

目标：删除过渡期代码。

- 删 kimi `reasoning_effort` 双发（确认服务端所有 kimi 模型已接受新 wire 格式后执行；这是唯一依赖服务端的收尾项）。
- 删 `effectiveDefaultEffort`（被 `defaultLevelFor` 覆盖，确认无引用后删除）。
- 删 acp `THINKING_ON_LEVEL` 常量（如步骤 3 未删）。
- 文档最终校对。

## 7. 逐文件改动清单

| 包 | 文件 | 改动 |
|---|---|---|
| kosong | `src/provider.ts` | 删 `ThinkingEffort`；新增 `ThinkingLevel` |
| kosong | `src/providers/kimi.ts` | `withThinking` 重写；删 `kimiEffort` / `wireEffortToThinkingEffort`；getter 简化 |
| node-sdk | `src/session.ts` | `setThinking(level: ThinkingLevel)` |
| node-sdk | `src/types.ts` | 导出 `ThinkingLevel` |
| agent-core | `src/config/schema.ts` | `ThinkingConfigSchema` 删 `mode`；顶层删 `defaultThinking` |
| agent-core | `src/agent/config/thinking.ts` | `resolveThinkingLevel` 重写；`defaultLevelFor`；删 `resolveThinkingEffort` / `DEFAULT_THINKING_EFFORT` / `effectiveDefaultEffort` |
| agent-core | `src/agent/config/index.ts` | `_thinkingLevel: ThinkingLevel`；getter 删 always_thinking clamp |
| agent-core | `src/rpc/core-impl.ts` | `createSession` 调用新 resolve |
| agent-core | `src/config/env-model.ts` | 删 `KIMI_MODEL_THINKING_MODE` 或改设 `enabled` |
| acp-adapter | `src/session.ts` | 删 always_thinking clamp；`THINKING_ON_LEVEL` 改动态 |
| kimi-code | `src/tui/types.ts` | 删 `thinking: boolean`，留 `thinkingLevel: ThinkingLevel` |
| kimi-code | `src/tui/kimi-tui.ts` | 删 `thinking` 初始化 / syncRuntimeState 写入 / createSession 派生 |
| kimi-code | `src/tui/commands/config.ts` | `performModelSwitch` 用 `thinkingLevel`；持久化走 `thinkingLevelToConfig` |
| kimi-code | `src/tui/commands/provider.ts` | `setDefaultModel` 同上 |
| kimi-code | `src/tui/commands/prompts.ts` | 适配 `ThinkingLevel`（删 boolean 转换） |
| kimi-code | `src/tui/controllers/auth-flow.ts` | 读 `config.thinking.enabled` |
| kimi-code | `src/tui/components/dialogs/model-selector.ts` | 提交前归一 `'on'`；`ModelSelection.thinking: ThinkingLevel` |
| kimi-code | `src/tui/components/dialogs/effort-selector.ts` | 类型 `ThinkingLevel` |
| kimi-code | `src/tui/components/chrome/footer.ts` | 从 `thinkingLevel` 派生 |
| kimi-code | `src/tui/components/messages/status-panel.ts` | 从 `thinkingLevel` 派生 |
| kimi-code | `src/tui/utils/thinking-config.ts`（新增） | `thinkingLevelToConfig` / `isThinkingOn` / `thinkingLabel` |
| docs | `en/configuration/config-files.md` | `[thinking]` 字段说明 |
| docs | `en/configuration/env-vars.md` | 删 `KIMI_MODEL_THINKING_MODE` 或更新 |
| docs | `zh/...` | 同步翻译 |

## 8. 测试计划

就近扩展，不新增泛化测试文件。

- `packages/kosong`（kimi provider）
  - `withThinking('high')` 在 effort 模型发 `{ type: 'enabled', effort: 'high' }`，`reasoning_effort === 'high'`。
  - `withThinking('max')` 同上，`effort === 'max'`。
  - `withThinking('xhigh')` 在 effort 模型发 `{ type: 'enabled' }`（不带 effort），`reasoning_effort === undefined`。
  - `withThinking('on')` 在 effort 模型发 `{ type: 'enabled' }`。
  - `withThinking('foo')` 在 effort 模型发 `{ type: 'enabled' }`。
  - `withThinking('on')` 在 boolean 模型发 `{ type: 'enabled' }`。
  - `withThinking('off')` 发 `{ type: 'disabled' }`，`reasoning_effort === undefined`。
  - `thinkingEffort` getter：`{enabled, effort:'max'}` → `'max'`；`{enabled}` → `'on'`；`{disabled}` → `'off'`；未设置 → `null`。
- `packages/agent-core`（config / thinking）
  - `defaultLevelFor`：不支持 thinking → `'off'`；effort 模型 → `defaultEffort` / 中位；boolean 模型 → `'on'`。
  - `resolveThinkingLevel`：requested 优先；`enabled=false` → `'off'`；always_thinking + `'off'` → 默认档。
  - `ThinkingConfigSchema` 拒绝 `mode`；`KimiConfigSchema` 拒绝 `defaultThinking`。
- `apps/kimi-code`
  - `model-selector.test.ts`：`'on'` 提交时归一为 `defaultLevelFor`；`ModelSelection.thinking` 类型 `ThinkingLevel`。
  - `effort-selector.test.ts`：类型 `ThinkingLevel`。
  - `thinking-config.test.ts`（新增或并入现有 commands 测试）：`thinkingLevelToConfig('off')` → `{ enabled: false }`；`thinkingLevelToConfig('max')` → `{ enabled: true, effort: 'max' }`。
  - `auth-flow` 相关：`refreshConfigAfterLogin` 读 `thinking.enabled`。

跑测试：

```bash
pnpm --filter @moonshot-ai/kosong test -- kimi
pnpm --filter @moonshot-ai/agent-core test -- thinking config
pnpm --filter @moonshot-ai/kimi-code test -- model-selector effort-selector
pnpm --filter @moonshot-ai/acp-adapter test
```

类型检查 / lint：

```bash
pnpm --filter @moonshot-ai/kimi-code typecheck
pnpm lint
```

## 9. 范围外 / 后续

- 按模型分别记住 effort（`[thinking.model_efforts]`）：当前用全局 `thinking.effort`，切模型时由 provider 归一；若需要精确记忆再加。
- 真正实现 `mode=auto` 的"按任务/模型自适应"：本期直接删除该值，未来按需设计。
- kimi-web 端：同步 `ThinkingLevel` 类型与配置字段。
- `setThinking` 类型严格化：当前 `ThinkingLevel` 塌缩为 `string`；若未来需要真正的运行时校验，可在 SDK 入口加 `isThinkingLevel`（非空 + 字符集白名单），但不依赖模型 `support_efforts`。
