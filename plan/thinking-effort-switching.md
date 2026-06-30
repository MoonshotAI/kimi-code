# Thinking Effort 多档位切换方案

## 1. 背景与目标

新模型支持切换 reasoning effort，约 `low` / `high` / `max` 三档。模型目录会为每个模型返回：

- `support_efforts = ["low", "high", "max"]`：该模型支持的档位列表（按模型不同）。
- `default_effort = "high"`：该模型的出厂默认档位。

目标：

1. 把 `support_efforts` / `default_effort` 像现有能力值一样存进 `config.toml`。
2. 在 `/model` 选择器里，把模型下方的 thinking 控件从「On/Off 两段」扩展为「多档位」，并默认高亮默认值。
3. 用户切换档位时立即生效，并更新**全局** `thinking.effort`（复用现有字段，跨重启自动保留）。

非目标（本期不做）：

- 按模型分别记住不同 effort（先全局生效，后续有需要再加）。
- 改动 agent-core 的 effort 解析逻辑（客户端始终下发具体档位，解析逻辑不变）。

## 2. 现状关键事实

- **数据流（上游→下游）**：managed 模型目录 → `packages/oauth` 解析并写入 `config.toml` → `/models` 从 `config.toml` 透出；TUI 直接读 `config.toml`。
- **模型条目刷新**：managed（`kimi-code`）模型每次刷新会**整条删除再重建**（`packages/oauth/src/managed-kimi-code.ts:464-478`），所以用户偏好**不能**存在模型条目里，会被冲掉。
- **能力存储**：`config.toml` 里 `[models.<id>]` 下的 `capabilities = ["thinking", "always_thinking", "tool_use", ...]`（字符串标签数组）。
- **全局 effort 已存在**：`ThinkingConfigSchema = { mode?, effort? }`，`resolveThinkingEffort` 已用 `thinking.effort` 作为 `'on'` 的默认值（缺省 `'high'`）。
- **底层已支持多档**：`ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`，`Session.setThinking(level: string)` 接受任意字符串。
- **kimi provider 当前发 `reasoning_effort`**：`packages/kosong/src/providers/kimi.ts` 的 `withThinking` 目前把 effort 映射成 `reasoning_effort`（与 openai 一致），同时额外发一个 `thinking: { type }`。新接口要求改成在 `thinking` 对象里带 `effort`；过渡期 `reasoning_effort` **仍保留一起传**（加 TODO，后续再删）。
- **TUI 当前是布尔 On/Off**：`apps/kimi-code/src/tui/components/dialogs/model-selector.ts`，`←/→` 翻转布尔，`On` 左、`Off` 右。

## 3. 设计决策（已确认）

| 决策点 | 结论 |
|---|---|
| `support_efforts` / `default_effort` 存哪 | 模型条目 `[models.<id>]` 下的独立字段，与 `capabilities` 平级 |
| Off 行为 | 复用现有 `always_thinking` / `thinking` 标签：`always_thinking` 无 Off，`thinking` 有 Off |
| 用户选择存哪 | **全局** `thinking.effort`（已有字段）；不新增按模型的表 |
| 跨重启 | 切换写入 `thinking.effort`，现有解析逻辑会自动用它，跨重启自然保留 |
| `default_effort` 角色 | 模型出厂默认值（随刷新更新）；用于选择器里非当前模型的初始高亮 |
| kimi 请求里的 effort | 新增 `thinking: { type, effort? }`（`keep` 恒为 `all`，本期不传；仅当模型有 `supportEfforts` 时带 effort）；`reasoning_effort` 过渡期**继续一起传**（加 TODO，后续删除） |

## 4. config.toml 形态

```toml
default_model = "kimi-code/kimi-k2"
default_thinking = true

[thinking]
mode = "auto"
effort = "max"          # 用户切换后更新这里（全局）

[models."kimi-code/kimi-k2"]
provider = "kimi-code"
model = "kimi-k2"
max_context_size = 262144
capabilities = ["thinking", "always_thinking", "tool_use"]
support_efforts = ["low", "high", "max"]   # 新增（接口给，随刷新）
default_effort = "high"                     # 新增（接口给，随刷新）
```

## 5. 配置 schema 改动

### 5.1 `packages/agent-core/src/config/schema.ts`

`ModelAliasSchema` 新增两个可选字段（**通用**，任何 provider 的模型都可以有）：

```ts
supportEfforts: z.array(z.string()).optional(),
defaultEffort: z.string().optional(),
```

> managed 模型由接口自动写入；其它模型（openai / anthropic / 自定义 provider 等）也可以**手动在 `config.toml` 的 `[models.<id>]` 里写 `support_efforts` / `default_effort`**，UI 读到就会展示多档位切换。

`ThinkingConfigSchema` **不变**（复用现有 `effort`）。

### 5.2 `packages/protocol/src/modelCatalog.ts`

`modelCatalogItemSchema` 新增：

```ts
support_efforts: z.array(z.string()).optional(),
default_effort: z.string().optional(),
```

### 5.3 `packages/agent-core/src/services/modelCatalog/modelCatalog.ts`

`toProtocolModel()` 把 `alias.supportEfforts` / `alias.defaultEffort` 透到 `support_efforts` / `default_effort`，让 `/models` 返回。

## 6. OAuth 解析与写入

### 6.1 `packages/oauth/src/managed-kimi-code.ts`

- `ManagedKimiCodeModelInfo` 新增 `supportEfforts?: readonly string[]`、`defaultEffort?: string`。
- `toModelInfo()`（约 `:364`）解析 `support_efforts`（字符串数组，过滤非字符串/空串）与 `default_effort`（非空字符串）。新增一个小工具 `parseStringArray()`。
- 写 config 的循环（`:469-478`）把 `supportEfforts` / `defaultEffort` 写进模型条目。

### 6.2 `packages/oauth/src/open-platform.ts`

为保持一致，同步在 `toModelInfo()`（`:44`）解析、模型写入（`:173-182`）带上这两个字段（open-platform 路径共用 `ManagedKimiCodeModelInfo`）。

## 7. kosong kimi provider 改造（新 wire 格式）

文件：`packages/kosong/src/providers/kimi.ts`，并把 `supportEfforts` 从 `ModelAlias` 透到 provider（见下方第 5 点）。

新接口格式：

```json
{ "thinking": { "type": "enabled", "keep": "all", "effort": "high" } }
```

- `keep` 恒为 `all`，本期**不传**。
- `effort` 放在 `thinking` 对象内（仅当模型有 `supportEfforts` 时）。
- `reasoning_effort` 过渡期**继续一起传**（加 `TODO`，后续再删）。

改动点：

1. **`ThinkingConfig` 接口**（`:74-78`）：新增 `effort?: string`（已有 `[key: string]: unknown` 兜底，显式声明更清晰）。

2. **`withThinking(effort)`**（`:500-524`）重写：
   - `kimiEffort(effort)` 映射（唯一映射，**删除旧的 `high/xhigh/max→high` clamp**）：`low→low`、`medium→medium`、`high→high`、`xhigh→high`（kimi 无 xhigh）、`max→max`。
   - 构造 `thinking`：`effort === 'off'` → `{ type: 'disabled' }`；否则模型有 `supportEfforts`（非空）→ `{ type: 'enabled', effort: kimiEffort(effort) }`；否则（旧模型）→ `{ type: 'enabled' }`（无 effort）。
   - `reasoningEffort`：**仅当 `effort !== 'off'` 且模型有 `supportEfforts`** 时取 `kimiEffort(effort)`（与 `thinking.effort` 同值），否则 `undefined`；旁加 `TODO` 注释标明后续删除。
   - 返回 `_withGenerationKwargs({ reasoning_effort: reasoningEffort })` + `withExtraBody({ thinking })`。

3. **`thinkingEffort` getter**（`:415-417`）：从 `extra_body.thinking` 反推（不再读 `reasoning_effort`，旧的反推映射一并删除）：
   - `thinking` 未设置 → `null`。
   - `type === 'disabled'` → `'off'`。
   - `thinking.effort` 存在 → 反查为 `ThinkingEffort`（`'low'/'medium'/'high'/'xhigh'/'max'`，未知值兜底 `'high'`）。
   - `type === 'enabled'` 但无 `effort`（旧模型）→ `'high'`（逻辑默认档）。
   - 由此 `reasoningEffortToThinkingEffort` 在 kimi.ts 不再使用，移除该 import。

4. **`reasoning_effort` 字段**：本期保留，但与 `thinking.effort` **同值**（统一走 `kimiEffort`，旧的 clamp 映射删除），且**同样按 `supportEfforts` 门控**（旧模型不再发 `reasoning_effort`）；代码里加 `TODO`，待新 wire 格式全量上线后删除（见第 11 节）。

5. **把 `supportEfforts` 透到 provider**（`packages/agent-core/src/session/provider-manager.ts`）：
   - `KimiOptions` 新增 `supportEfforts?: readonly string[]`；`KimiChatProvider` 构造时存为私有字段，`_clone()` 通过 `Object.assign` 自动保留。
   - `toKosongProviderConfig` 新增 `supportEfforts` 参数，`case 'kimi'` 里写入 provider config。
   - `resolveProviderConfig` 调用 `toKosongProviderConfig` 时传入 `alias.supportEfforts`。
   - `withThinking` 用该字段决定是否带 `effort`。

> 注意：`thinking: { type }` 之前就已经在发，本次只是在该对象里（按能力）加 `effort`；`reasoning_effort` 暂时仍保留一起发，改动面很小。

> 其它 provider（openai / anthropic / google-genai 等）的 `withThinking` 已经各自把 `ThinkingEffort` 映射到自己的原生参数，**本期不改**。这些模型只要（手动）配了 `support_efforts`，UI 就能切换档位，选中的档位照旧走各 provider 现有的 `withThinking` 传参逻辑。只有 kimi provider 需要按 `supportEfforts` 门控 `thinking.effort` / `reasoning_effort`。

## 8. TUI 改造

### 8.1 `model-selector.ts`（核心）

**类型变化**

- `ModelSelection.thinking`：`boolean` → `string`（档位：`'off'`、`'on'`、或具体 effort 如 `'high'`）。
- `ModelSelectorOptions.currentThinking: boolean` → `currentThinkingLevel: string`（当前模型的运行时档位）。
- 内部 `thinkingOverrides: Map<alias, boolean>` → `Map<alias, string>`。

**新增工具**

```ts
function effortsOf(model: ModelAlias): readonly string[] {
  return model.supportEfforts ?? [];
}
```

**分段（segments）规则**

| 模型类型 | segments | 说明 |
|---|---|---|
| 不支持 thinking | `['off']`（渲染 On 不可选 + `[Off]`，保持现状） | 不变 |
| 普通 toggle（无 effort） | `['on', 'off']` | 不变 |
| always-on（无 effort） | `['on']` | 不变 |
| toggle + effort | `['off', ...supportEfforts]` | Off 在最左 |
| always-on + effort | `[...supportEfforts]` | 无 Off |

> effort 模型 Off 放最左；非 effort 模型保持 `On` 左 / `Off` 右，避免改动现有视觉。

**高亮（draftFor）**

- 有 `←/→` override → override。
- 当前模型 → `currentThinkingLevel`（运行时实际档位）。
- 其它 effort 模型 → `defaultEffort`（若在 `supportEfforts` 内），否则 `supportEfforts[0]`。
- 其它非 effort 模型 → 保持现有逻辑（capable 默认 `'on'`，否则 `'off'`）。

**键盘**

- `←`：active 段左移一位（到最左停）。
- `→`：active 段右移一位（到最右停）。
- 不循环；不支持的模型忽略。

**渲染 `renderThinkingControl`**

按 `segmentsFor(model)` 渲染所有段，active 段用 `boldFg('primary', '[ label ]')`，其余 `fg('text', '  label  ')`；不支持的侧保持 `textMuted` + `(Unsupported)`（仅非 effort 的 always-on/unsupported 路径保留）。段标签首字母大写（`off`→`Off`，`low`→`Low`，`max`→`Max`）。

**标题行**

- toggle / effort 模型可切换时显示 `Thinking  (←→ to switch)`，否则 `Thinking`。

### 8.2 `tabbed-model-selector.ts`

透传：`TabbedModelSelectorOptions.currentThinking` → `currentThinkingLevel`，`makeSelector` 里传 `currentThinkingLevel`。`onSelect` 的 `thinking` 现在是 string，直接转发。

### 8.3 `commands/config.ts`

- `showModelPicker`：`currentThinkingLevel: host.state.appState.thinkingLevel ?? (host.state.appState.thinking ? 'on' : 'off')`。
- `performModelSwitch(host, alias, level: string, persist)`：
  - `const prevLevel = host.state.appState.thinkingLevel ?? (host.state.appState.thinking ? 'on' : 'off')`
  - session 路径：`alias !== prevModel` → `setModel(alias)`；`level !== prevLevel` → `setThinking(level)`（直接传档位字符串）。
  - 无 session：`authFlow.activateModelAfterLogin(alias, level)`。
  - `setAppState({ model: alias, thinking: level !== 'off', thinkingLevel: level })`。
  - 状态文案：`thinking on/off` → 直接显示档位（如 `thinking high`）。
- `persistModelSelection(host, alias, level: string)`：
  - `defaultModel = alias`
  - `defaultThinking = level !== 'off'`
  - 若 `level` 是具体 effort（`level !== 'on' && level !== 'off'`）→ 写 `thinking: { effort: level }`（`setConfig` 深合并，保留 `thinking.mode`）。
  - 仅在 `defaultModel` / `defaultThinking` / `thinking.effort` 任一变化时调用 `setConfig`。

### 8.4 `commands/provider.ts`

`setDefaultModel(host, alias, thinking)` 的 `thinking` 由 `boolean` 改为 `level: string`，写 `defaultThinking: level !== 'off'`，并在具体 effort 时写 `thinking.effort`。两处 `onSelect` 透传 string。两处 `currentThinking` → `currentThinkingLevel`。

### 8.5 `commands/prompts.ts`（`runModelSelector`）

- 选项 `currentThinking` → `currentThinkingLevel: initialThinking ? 'on' : 'off'`。
- `onSelect` 拿到 string level，返回时转回 boolean：`{ alias, thinking: level !== 'off' }`（open-platform / catalog 模型无 effort 字段，level 只会是 `'on'`/`'off'`）。

### 8.6 `types.ts` / `kimi-tui.ts` / `auth-flow.ts` / `footer.ts`

- `AppState` 新增 `thinkingLevel?: string`（运行时档位）。
- `kimi-tui.ts syncRuntimeState`（`:1201`）：加 `thinkingLevel: status.thinkingLevel`。
- `kimi-tui.ts` 初始 state（`:193`）与 logout 重置：`thinkingLevel: 'off'`。
- `kimi-tui.ts:1176-1177` reload 建 session：`thinking` 用 `this.state.appState.thinkingLevel ?? (this.state.appState.thinking ? 'on' : 'off')`，保留具体档位。
- `auth-flow.ts activateModelAfterLogin(model, level?: string)`：参数由 `thinking?: boolean` 改为 `level?: string`，直接传给 `setThinking` / `CreateSessionOptions.thinking`。`refreshConfigAfterLogin` 里 `activateModelAfterLogin(defaultModel, config.defaultThinking === false ? 'off' : undefined)`。
- `footer.ts:265`：有 effort 时显示档位，例如 `state.thinkingLevel` 为具体 effort 时渲染 ` thinking:max`，否则保持 ` thinking`。

## 9. 逐文件改动清单

| 包 | 文件 | 改动 |
|---|---|---|
| kosong | `src/providers/kimi.ts` | `withThinking` 新增 `thinking: { type, effort? }`（仅当模型有 supportEfforts 时带 effort）；`reasoning_effort` 暂保留但与 effort 同值、同样按 supportEfforts 门控，旧 clamp 映射删除并加 TODO；`thinkingEffort` getter 从 `thinking` 反推；`KimiOptions` 加 `supportEfforts` |
| agent-core | `src/session/provider-manager.ts` | `toKosongProviderConfig` 透传 `supportEfforts`；`resolveProviderConfig` 传入 `alias.supportEfforts` |
| agent-core | `src/config/schema.ts` | `ModelAliasSchema` 加 `supportEfforts` / `defaultEffort` |
| agent-core | `src/services/modelCatalog/modelCatalog.ts` | `toProtocolModel` 透出两字段 |
| protocol | `src/modelCatalog.ts` | `modelCatalogItemSchema` 加 `support_efforts` / `default_effort` |
| oauth | `src/managed-kimi-code.ts` | `ManagedKimiCodeModelInfo` + `toModelInfo` + 写 config |
| oauth | `src/open-platform.ts` | `toModelInfo` + 写 config（同步） |
| kimi-code | `src/tui/components/dialogs/model-selector.ts` | 多档位 UI + 键盘 + 类型 |
| kimi-code | `src/tui/components/dialogs/tabbed-model-selector.ts` | 透传 `currentThinkingLevel` |
| kimi-code | `src/tui/commands/config.ts` | 档位化切换 + 持久化 `thinking.effort` |
| kimi-code | `src/tui/commands/provider.ts` | `setDefaultModel` 档位化 |
| kimi-code | `src/tui/commands/prompts.ts` | `runModelSelector` 适配 string level |
| kimi-code | `src/tui/types.ts` | `AppState.thinkingLevel` |
| kimi-code | `src/tui/kimi-tui.ts` | syncRuntimeState / 初始 / reload |
| kimi-code | `src/tui/controllers/auth-flow.ts` | `activateModelAfterLogin` 档位化 |
| kimi-code | `src/tui/components/chrome/footer.ts` | 显示 effort 档位 |

## 10. 测试计划

就近扩展，不新增泛化测试文件：

- `packages/kosong`（kimi provider 测试）
  - `withThinking('high')` 在模型有 `supportEfforts` 时发出 `thinking: { type: 'enabled', effort: 'high' }`，且 `reasoning_effort === 'high'`。
  - `withThinking('max')` 在模型有 `supportEfforts` 时：`thinking.effort === 'max'` 且 `reasoning_effort === 'max'`（同值，无 clamp）。
  - `withThinking('high')` 在模型无 `supportEfforts` 时发出 `thinking: { type: 'enabled' }`（无 effort），且 `reasoning_effort === undefined`（按能力门控，旧模型不再发）。
  - `withThinking('off')` 发出 `thinking: { type: 'disabled' }`，`reasoning_effort === undefined`。
  - `thinkingEffort` getter：从 `thinking` 反推（`{enabled, effort:'max'}`→`'max'`、`{enabled}`→`'high'`、`{disabled}`→`'off'`、未设置→`null`）。
- `packages/agent-core`（provider-manager 测试）
  - `resolveProviderConfig` 把 `alias.supportEfforts` 透到 kimi provider config。

- `apps/kimi-code/test/tui/components/dialogs/model-selector.test.ts`
  - 现有 On/Off 用例：`currentThinking` → `currentThinkingLevel`（`'on'`/`'off'`），断言 `thinking` 为字符串。
  - 新增 effort 用例：
    - effort 模型渲染 `[Off] [Low] [High] [Max]`（toggle）/ `[Low] [High] [Max]`（always-on）。
    - 默认高亮 `defaultEffort`。
    - `←/→` 在多档间移动并到端点停止；Enter 下发具体档位。
    - 当前模型高亮运行时档位（`currentThinkingLevel`）。
    - 切到 Off 时下发的 `thinking === 'off'`。
- `apps/kimi-code/test/tui/components/dialogs/tabbed-model-selector.test.ts`
  - 透传 `currentThinkingLevel`；断言 string 档位透传。
- `packages/oauth` 现有测试
  - `toModelInfo` 解析 `support_efforts` / `default_effort`。
  - 写 config 时模型条目包含 `supportEfforts` / `defaultEffort`。
- `packages/agent-core` 配置相关测试
  - `ModelAliasSchema` 接受新字段；`toProtocolModel` 透出。

跑测试：

```bash
pnpm --filter @moonshot-ai/kimi-code test -- model-selector tabbed-model-selector
pnpm --filter @moonshot-ai/oauth test
pnpm --filter @moonshot-ai/kosong test -- kimi
pnpm --filter @moonshot-ai/agent-core test -- modelCatalog provider-manager
```

类型检查 / lint：

```bash
pnpm --filter @moonshot-ai/kimi-code typecheck
pnpm lint
```

## 11. 范围外 / 后续

- 删除 kimi provider 的 `reasoning_effort`（待新 `thinking.effort` wire 格式全量上线、所有 kimi 模型都接受后；代码里已留 `TODO`）。
- 按模型分别记住 effort（先全局；若需要，再加 `[thinking.model_efforts]` 之类的覆盖表）。
- agent-core 解析感知 `default_effort`（本期客户端始终下发具体档位，无需改动）。
- kimi-web 端的多档 UI（`/models` 透出字段后，web 已具备 `ThinkingLevel` 模型，可另行接入）。
