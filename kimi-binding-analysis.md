# Kimi 生态绑定分析与解绑方案

> 分析版本：基于 `apps/kimi-code@0.29.2` / `packages/kosong@0.5.5` / `packages/oauth@*`
> 分析日期：2026-07-29
> 实施日期：2026-07-30 · 方案 B 标准解耦

---

## 变更日志 (Changelog)

### 2026-07-30 — 方案 B 标准解耦实施

#### 架构变更

- **`packages/oauth/src/open-platform.ts`** — `OpenPlatformDefinition` 新增 `providerType` 字段，支持非 Kimi 的 provider 类型（如 `openai`）。新增 `fetchGenericOpenAIModels()` 函数，通过标准 OpenAI-compatible `/v1/models` 端点发现模型。新增 `GENERIC_MODEL_FALLBACKS` 内置模型能力表（覆盖 DeepSeek V4 / Qwen3.7 / GLM-5.1 / Kimi K3 / Baichuan4 / MiniMax-M3 等 30+ 国内模型）。
- **`packages/oauth/src/refreshProviderModels.ts`** — 新增 §2.6 "Generic OpenAI-compatible providers" 刷新分支，对 `type: 'openai'` 的 provider 自动调用 `fetchGenericOpenAIModels` 进行模型发现。
- **`packages/oauth/src/identity.ts`** — `createKimiDefaultHeaders()` 新增 `includeDeviceHeaders` 参数（默认 `true`），可在非 Kimi 场景下抑制 `X-Msh-*` 设备标识头。
- **`packages/agent-core/src/config/kimi-env-params.ts`** — 将 `instanceof KimiChatProvider` / `instanceof AnthropicChatProvider` 替换为运行时 `provider.name` 检查 + `KimiProviderApi` / `AnthropicProviderApi` 类型窄化。消除对 concrete class 的直接依赖。
- **`packages/agent-core/src/agent/llm-request-recorder.ts`** — 同上，`instanceof → provider.name` 检查。

#### TUI 变更

- **`apps/kimi-code/src/tui/controllers/auth-flow.ts`** — 新增 `enterStartupWizardState()` 方法：当启动时无 provider 配置，立即弹出平台选择器而非等待用户输入 `/login`。
- **`apps/kimi-code/src/tui/commands/auth.ts`** — 新增 `handleGenericProviderLogin()` 函数，处理泛用 provider 的配置流程（选厂商 → 输 API Key → 拉取模型列表 → 选模型 → 写配置）。
- **`apps/kimi-code/src/tui/commands/prompts.ts`** — 新增 `promptGenericProviderSetup()` 函数 + `PROVIDER_PRESETS` 国内 6 大厂商预设（DeepSeek/Qwen/智谱/百川/MiniMax/Ollama），含正确的 base URL。
- **`apps/kimi-code/src/tui/components/dialogs/platform-selector.ts`** — 新增 "Generic Provider" 选项连接到泛用配置流程。
- **`apps/kimi-code/src/tui/kimi-tui.ts`** — 启动时若 `AUTH_LOGIN_REQUIRED`，改为调用 `enterStartupWizardState` 并自动弹出 `/login` 向导。

#### Web 界面变更

- **`apps/kimi-web/src/components/settings/ProviderManager.vue`** — `PROVIDER_TYPES` 预设全面更新：所有模型名更新为最新版本（DeepSeek V4 / Qwen3.7 / Kimi K3 / GLM-5.1 等），新增智谱 GLM / 百川 / MiniMax 三家厂商，移除 OpenAI / Anthropic 预设，精简 OAuth 登录按钮。
- **`apps/kimi-web/src/i18n/locales/en/providers.ts`** — 新增 `zhipu` / `baichuan` / `minimax` 类型标签，移除 `openai` / `anthropic` / `loginAnthropic`。
- **`apps/kimi-web/src/i18n/locales/zh/providers.ts`** — 同上（中文）。

#### 模型数据来源（官方 API 文档，截至 2026-07-29）

| 厂商 | 最新模型 | 上下文 | Base URL |
|---|---|---|---|
| DeepSeek | `deepseek-v4-pro` / `deepseek-v4-flash` | 1M | `api.deepseek.com/v1` |
| 通义千问 Qwen | `qwen3.7-max` / `qwen3.7-plus` / `qwen3.6-flash` | 256K | `dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi | `kimi-k3` / `kimi-k2.7-code` | 262K | `api.moonshot.ai/v1` |
| 智谱 GLM | `glm-5.1` / `glm-5` / `glm-4.7` | 200K | `open.bigmodel.cn/api/paas/v4` |
| 百川 | `Baichuan4` / `Baichuan4-Turbo` | 128K | `api.baichuan-ai.com/v1` |
| MiniMax | `MiniMax-M3` / `MiniMax-M2.7` | 262K | `api.minimax.io/v1` |
| Ollama | 本地部署 | — | `localhost:11434/v1` |

#### 验证

| 检查项 | 结果 |
|---|---|
| `packages/oauth` typecheck | ✅ |
| `packages/agent-core` typecheck | ✅ |
| `apps/kimi-web` typecheck (vue-tsc) | ✅ |
| `apps/kimi-web` check:style (baseline) | ✅ 无新违规 |
| `kimi-env-params.test.ts` (46 tests) | ✅ |
| `llm-request-recorder.test.ts` (11 tests) | ✅ |

#### 向后兼容

- 所有现有 Kimi 用户不受影响，OAuth 登录路径保持不变
- Kimi Open Platform (API Key) 路径保持不变
- `managed:kimi-code` provider 继续正常工作
- `X-Msh-*` 设备标识头默认仍然发送（仅新增 opt-out 能力）

---

## 一、绑定总览

Kimi Code CLI 是 Moonshot AI 为 Kimi 模型打造的 AI 编程助手，与 Kimi 生态存在 **6 个层面的深度绑定**。绑定程度从最深（认证/配置）到最浅（品牌/分发）递减。

| 层 | 绑定程度 | 抽象现状 | 核心问题 |
|---|---|---|---|
| **认证（oauth）** | 🔴 深 | ❌ 整个包都是 Kimi 专属 | OAuth Device Code 硬编码 `auth.kimi.com` |
| **默认供应商** | 🔴 深 | ❌ 首次启动强制 Kimi 登录 | 无跳过登录路径 |
| **模型发现** | 🔴 深 | ❌ `/models` 只指向 `api.kimi.com` | managed 模式与 OAuth 深度耦合 |
| **用量管理** | 🔴 深 | ❌ `/usages` 只指向 Kimi | 配额/限流是 Kimi 专属概念 |
| **内置服务** | 🔴 深 | ❌ 搜索/抓取硬编码 Kimi | 服务框架不可插拔 |
| **LLM 推理（kosong）** | 🟡 中等 | ✅ `ChatProvider` 接口支持 6 种 provider | Kimi 有专有 API 特性（thinking / builtin_function） |
| **配置系统** | 🟢 较低 | ✅ TOML 配置已支持多 provider | managed provider 是"魔法"路径 |
| **引擎（agent-core-v2）** | 🟢 低 | ✅ provider-agnostic | 基本无绑定 |
| **品牌/命名** | 🟡 中等 | ❌ 渗透全局 | 包名/二进制名/常量全部包含 "kimi" |
| **分发/安装** | 🟡 中等 | ❌ CDN 写死 `code.kimi.com` | 安装/更新脚本依赖 Kimi 服务器 |
| **设备标识** | 🔴 深 | ❌ `X-Msh-*` 头随请求发送 | 设备指纹仅对 Kimi 有效 |

---

## 二、逐层详细分析

### 2.1 认证层（`packages/oauth/`）— 最大耦合点

```
packages/oauth/
├── src/
│   ├── constants.ts          # DEFAULT_KIMI_CODE_OAUTH_HOST, clientId
│   ├── identity.ts           # X-Msh-* 设备标识头, KIMI_CODE_PLATFORM
│   ├── managed-kimi-code.ts  # managed:kimi-code 魔法 provider
│   ├── managed-usage.ts      # /usages 端点
│   ├── oauth-manager.ts      # OAuthManager — Device Code 流程
│   ├── oauth.ts              # OAuth HTTP 请求
│   └── open-platform.ts      # Open Platform API key 模式
```

#### 核心文件详析

**`constants.ts`** — OAuth 端点硬编码
```typescript
// packages/oauth/src/constants.ts
export const DEFAULT_KIMI_CODE_OAUTH_HOST = 'https://auth.kimi.com';
export const KIMI_CODE_FLOW_CONFIG: OAuthFlowConfig = {
  name: 'kimi-code',
  oauthHost: process.env['KIMI_CODE_OAUTH_HOST'] ?? 
             process.env['KIMI_OAUTH_HOST'] ?? 
             DEFAULT_KIMI_CODE_OAUTH_HOST,
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098', // Kimi 注册的 client
};
```

**`identity.ts`** — 设备标识头
```typescript
// packages/oauth/src/identity.ts
export const KIMI_CODE_PLATFORM = 'kimi_code_cli';
// 每次 managed 请求都发送 X-Msh-Platform, X-Msh-Version,
// X-Msh-Device-Name, X-Msh-Device-Model, X-Msh-Os-Version, X-Msh-Device-Id
```

#### 解绑方案

| 改动 | 说明 |
|---|---|
| `constants.ts` 参数化 | `DEFAULT_KIMI_CODE_OAUTH_HOST` 和 `clientId` 从配置或环境变量读取 |
| `identity.ts` 门控 | `X-Msh-*` 头仅在 `type: 'kimi'` 且 `managed: true` 时发送 |
| `oauth-manager.ts` 降级 | `OAuthManager` 改为可选组件，非默认启动路径 |

---

### 2.2 默认供应商 — 首屏体验

**当前启动流程（硬绑定路径）**：

```
kimi CLI 启动
    ↓
检查 config.toml 是否有有效 provider
    ↓ (无)
弹出 TUI 登录界面 → 强制走 Kimi OAuth
    ↓
获取 OAuth token → 调用 api.kimi.com/coding/v1/models
    ↓
写入 managed:kimi-code provider 到 config.toml
    ↓
完成
```

**没有跳过此流程的路径。** 即使设置了 `KIMI_API_KEY` 环境变量或其他 provider 的环境变量，首次启动仍然要求登录。

#### 解绑方案

```
kimi CLI 启动
    ↓
检查是否有有效 provider
    ↓ (无)
┌──────────────────────────────────────┐
│ 首次使用向导                          │
│                                      │
│ ○ 登录 Kimi 托管服务（OAuth）         │
│ ● 使用自有 API key                   │
│   → 选择 provider 类型               │
│   → 输入 endpoint + key             │
│ ○ 跳过，稍后在 config.toml 中配置     │
└──────────────────────────────────────┘
```

需要修改的文件：
- `apps/kimi-code/src/tui/controllers/auth-flow.ts` — 认证流程控制器
- `apps/kimi-code/src/tui/kimi-tui.ts` — TUI 协调器
- `apps/kimi-code/src/cli/` — CLI 启动逻辑

---

### 2.3 模型发现层

**当前 `managed:kimi-code` 的自动发现流程**：

```typescript
// packages/oauth/src/managed-kimi-code.ts

// 1. 用 OAuth token 调用 Kimi 的 /models 端点
export const DEFAULT_KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';

// 2. 解析返回的模型列表
function toModelInfo(item: unknown): ManagedKimiCodeModelInfo | undefined {
  return {
    id: item['id'],
    contextLength: Number(item['context_length']),
    supportsReasoning: Boolean(item['supports_reasoning']),
    supportsThinkingType: parseSupportsThinkingType(item['supports_thinking_type']),
    // ... Kimi 专属字段
    protocol: parseModelProtocol(item['protocol']), // 'kimi' | 'anthropic'
  };
}
```

**问题**：模型发现流程本身就绑定在 OAuth + Kimi API 上。

#### 解绑方案

1. **对于标准 OpenAI-compatible API**：使用 OpenAI 的 `/v1/models` 端点发现模型
2. **对于 Anthropic**：使用 Anthropic 的 models API
3. **对于自定义 endpoint**：手动配置 model alias
4. **内置模型目录**（`__KIMI_CODE_BUILT_IN_CATALOG__` — `apps/kimi-code/src/built-in-catalog.ts`）：改为独立于 Kimi 的 model list

---

### 2.4 LLM Provider 层（`packages/kosong/`）— 抽象最好的一层

**当前状态**：`packages/kosong/src/providers/index.ts` 的 `createProvider()` 支持：
```typescript
type ProviderType = 'anthropic' | 'openai' | 'kimi' | 
                    'google-genai' | 'openai_responses' | 'vertexai';
```

每个实现 `ChatProvider` 接口（`packages/kosong/src/provider.ts`）。**这是全项目抽象最好的层，已支持 6 种 provider。**

#### 仍需处理的 Kimi 专属特性

| 特性 | 文件 | 说明 | 解绑方案 |
|---|---|---|---|
| `extra_body.thinking` | `kimi.ts#L77-L87` | 思考控制 `type`/`effort`/`keep`，Kimi 专有 | 通过 provider capability 门控，Anthropic 用 `thinking.budget_tokens` |
| `builtin_function` | `kimi.ts#L197-L213` | `$` 前缀的内置函数（`$web_search`） | 改为 MCP 工具模式 |
| `KimiFiles.uploadVideo` | `kimi.ts#L462-L474` | 视频上传到 Kimi Files API | 每个 provider 实现自己的文件上传 |
| `ReasoningKeyDialect` | `kimi.ts#L428` | 自动检测 `reasoning_content` vs `reasoning` | 仅 Kimi API 需要，其他 provider 用各自的 |
| `select_tools` | Kimi 专有 | 渐进式工具声明（先声明后调用） | Kimi 的 proprietary 能力 |

#### 上游代码的 `instanceof KimiChatProvider` 检查

`packages/kosong/src/index.ts#L33` 导出 `KimiChatProvider` 类，说明引擎/上层代码有 `instanceof` 类型窄化。这类检查需要替换为 capability-based 门控：

```typescript
// 当前（耦合）
if (provider instanceof KimiChatProvider) {
  // Kimi 专属处理
}

// 解绑后（能力驱动）
if (provider.capabilities.has('builtin_function')) {
  // 按能力处理
}
```

---

### 2.5 Open Platform 定义

```typescript
// packages/oauth/src/open-platform.ts
export const OPEN_PLATFORMS: readonly OpenPlatformDefinition[] = [
  {
    id: 'moonshot-cn',
    name: 'Kimi Platform (API key · platform.kimi.com)',
    baseUrl: 'https://api.moonshot.cn/v1',
    consoleUrl: 'https://platform.kimi.com',
    allowedPrefixes: ['kimi-k'],  // 只允许 kimi-k 前缀的模型
  },
  {
    id: 'moonshot-ai',
    name: 'Kimi Platform (API key · platform.kimi.ai)',
    baseUrl: 'https://api.moonshot.ai/v1',
    consoleUrl: 'https://platform.kimi.ai',
    allowedPrefixes: ['kimi-k'],
  },
];
```

#### 解绑方案

`OPEN_PLATFORMS` 改为可插拔的注册表。允许用户/社区注册任意 OpenAI-compatible 平台：

```typescript
// 解绑后
const OPEN_PLATFORMS = [
  { id: 'openai',      baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek',    baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'ollama',      baseUrl: 'http://localhost:11434/v1' },
  { id: 'moonshot-cn', baseUrl: 'https://api.moonshot.cn/v1' },
  // ... 从配置或内置目录读取
];
```

---

### 2.6 配置和模型 alias 系统

**当前配置结构**（`ManagedKimiConfigShape`）：

```typescript
// packages/oauth/src/managed-kimi-code.ts
interface ManagedKimiConfigShape {
  providers: Record<string, ManagedKimiProviderConfig>;
  models?: Record<string, ManagedKimiModelAlias>;
  defaultModel?: string;
  thinking?: ManagedKimiThinkingShape;
  services?: {                     // ← Kimi 专有
    moonshotSearch?: { baseUrl, oauth };
    moonshotFetch?: { baseUrl, oauth };
  };
}

interface ManagedKimiProviderConfig {
  type: ManagedKimiCodeProtocol;   // 'kimi' | 'anthropic'
  baseUrl?: string;
  apiKey?: string;
  oauth?: ManagedKimiOAuthRef;     // ← OAuth 绑定
}
```

#### 解绑方案

1. **`services.moonshotSearch`/`moonshotFetch`** → 降级为可选的 MCP 服务配置，不自动注入
2. **`oauth` 字段** → 仅在 `managed: true` 时存在
3. **`thinking` 配置** → 标准化，适配各 provider 的 thinking API

---

### 2.7 服务层（搜索 / 抓取）

```typescript
// packages/oauth/src/managed-kimi-code.ts#L625-636
// 登录成功后自动注入
config.services = {
  moonshotSearch: { baseUrl: `${baseUrl}/search`, apiKey: '', oauth },
  moonshotFetch:  { baseUrl: `${baseUrl}/fetch`,  apiKey: '', oauth },
};
```

**当前状态**：搜索和抓取是 Kimi 的 API 代理服务，通过 Kimi OAuth 认证。

#### 解绑方案

这些应该变为**可插拔的 MCP 工具**：
- 搜索：用户可以配置 Tavily、Bing Search、Brave Search 等
- 抓取：可以用 Jina Reader、自建 HTTP proxy 等
- 如果用户使用 Kimi provider，仍然可以自动注入 Kimi 版
- 如果用户使用其他 provider，则提供"搜索未配置"提示

---

### 2.8 品牌 / 命名

最广泛但最浅层的绑定：

| 位置 | 当前值 | 改为 |
|---|---|---|
| npm 包名 | `@moonshot-ai/kimi-code` | `@your-org/your-name` |
| 二进制名 | `kimi` | `your-cli` |
| 代码常量 | `KIMI_CODE_PLATFORM = 'kimi_code_cli'` | `'your_platform'` |
| package.json | author: "Moonshot AI" | 你的信息 |
| GitHub | `MoonshotAI/kimi-code` | `you/your-fork` |
| 环境变量前缀 | `KIMI_*` | `YOUR_*` |
| CLI 帮助文本 | "Kimi Code CLI" | 你的产品名 |

---

### 2.9 分发 / 安装

```typescript
// apps/kimi-code/src/cli/update/cdn.ts
// CDN URL 写死 code.kimi.com
```

安装脚本 `https://code.kimi.com/kimi-code/install.sh` — 在文档和 `package.json` 中多处引用。

#### 解绑方案

CDN URL 参数化，支持自定义更新源：`KIMI_UPDATE_URL=https://your-cdn.com/releases`

---

## 三、解绑难度矩阵

```
难度    层面              改动规模         架构影响        用户影响
─────────────────────────────────────────────────────────────
🟢 低   品牌/命名          全局替换        无              需要fork
🟢 低   分发/安装          ~5 个文件       无              无
🟡 中   Provider 抽象     ~10 个文件      低（已有接口）  低
🟡 中   模型/平台注册      ~5 个文件       中等            新增功能
🟡 中   首次启动向导       ~15 个文件      中等            体验变化
🟠 高   认证流程           ~25 个文件      较高            重大变化
🟠 高   managed provider  整个oauth包      核心链路        托管用户受影响
🔴 极高 服务框架           ~30 个文件      需新建框架      API变化
```

---

## 四、迁移路径

### 方案 A：最小改动（不改架构，仅绕过登录）

**目标**：不登录 Kimi 也能使用 CLI。

**步骤**：
1. 手动创建 `~/.kimi-code/config.toml`，配置自定义 provider
2. 设置环境变量跳过登录检查
3. CLI 启动时检测到已有有效 provider，不触发登录

**工作量**：极小（可能在现有代码中已部分支持，需要验证 `--no-login` 是否可用）

**局限性**：managed provider 的模型发现、用量管理、搜索/抓取不可用

---

### 方案 B：标准解耦（保持兼容，新增能力）

**目标**：在不破坏现有 Kimi 用户的前提下，支持任意 provider。

**步骤**：

| 阶段 | 内容 | 文件 |
|---|---|---|
| 1 | Provider type 扩展（开放 platform 注册表） | `packages/oauth/src/open-platform.ts` |
| 2 | 首次启动向导（新增 "跳过" 和 "自有 key" 选项） | `apps/kimi-code/src/tui/controllers/auth-flow.ts` |
| 3 | OAuth 降级为可选（provider 级控制） | `packages/oauth/src/oauth-manager.ts` |
| 4 | 模型发现适配各 provider（标准 /v1/models） | `packages/oauth/src/managed-kimi-code.ts` → 新文件 |
| 5 | 服务框架（搜索/抓取 → MCP 插件） | 新 `packages/services/` |
| 6 | 设施标识头门控 | `packages/oauth/src/identity.ts` |
| 7 | `instanceof` 替换为 capability 门控 | `packages/kosong/src/` 和上层使用方 |

**工作量**：中等（2-3 周）

**优势**：所有现有 Kimi 用户不受影响，新用户可直接用其他 provider

---

### 方案 C：完全解耦（fork + 重命名 + 去品牌化）

**目标**：生成完全不依赖 Kimi 的分支。

**步骤**：
1. 方案 B 的全部步骤
2. 全局重命名：包名、二进制名、环境变量前缀、常量
3. 去除所有 Kimi 品牌的 Open Platform 定义（或改为配置化）
4. 更新安装脚本和 CDN 配置
5. 更新文档

**工作量**：大（1 个月以上）

---

## 五、关键文件清单

### 必须修改的核心文件（按耦合程度排序）

| 优先级 | 文件 | 改什么 |
|---|---|---|
| P0 | `packages/oauth/src/constants.ts` | 参数化 OAuth host 和 clientId |
| P0 | `packages/oauth/src/managed-kimi-code.ts` | managed provider 改为可选的 provider type |
| P0 | `apps/kimi-code/src/tui/controllers/auth-flow.ts` | 首次启动向导，允许跳过登录 |
| P1 | `packages/oauth/src/open-platform.ts` | OPEN_PLATFORMS 改为可插拔注册表 |
| P1 | `packages/oauth/src/identity.ts` | X-Msh-* 头仅在 managed Kimi 时发送 |
| P1 | `packages/kosong/src/index.ts` | 去掉 `KimiChatProvider` 的对外导出 |
| P1 | `packages/oauth/src/managed-usage.ts` | /usages 仅对 managed provider 可用 |
| P2 | `packages/kosong/src/providers/kimi.ts` | Kimi 专有特性隔离 |
| P2 | `apps/kimi-code/src/cli/update/cdn.ts` | CDN URL 参数化 |
| P2 | `apps/kimi-code/src/built-in-catalog.ts` | 内置模型目录去品牌化 |

### 可重用的抽象（不需要改）

| 层 | 文件 | 说明 |
|---|---|---|
| Provider 接口 | `packages/kosong/src/provider.ts` | `ChatProvider` 接口已是 provider-agnostic |
| Provider 注册 | `packages/kosong/src/providers/index.ts` | `createProvider()` 支持 6 种 type |
| 配置系统 | agent-core-v2 config | TOML 配置已支持多 provider |
| 引擎 | `packages/agent-core-v2/` | DI × Scope 架构，完全 provider-agnostic |
| 客户端 SDK | `packages/klient/` | Facade 层与 provider 无关 |
| TUI 组件 | `apps/kimi-code/src/tui/components/` | UI 组件不直接访问 provider |

---

## 六、风险评估

| 风险 | 影响 | 缓解 |
|---|---|---|
| 破坏现有 Kimi 用户登录流程 | 高 | 方案 B 中保持向后兼容，managed provider 继续工作 |
| 解绑后 search/fetch 不可用 | 中 | 将服务层改为 MCP 插件式，提供 fallback 方案 |
| 专有 API 特性（thinking 控制）丢失 | 中 | 按 provider 能力矩阵适配 |
| 多 provider 模型发现不一致 | 低 | 每种 provider 实现自己的模型发现逻辑 |
| 品牌解耦需要 fork | 中 | 方案 C 考虑，方案 A/B 不需要 |

---

## 七、总结

Kimi Code CLI 的核心架构（`agent-core-v2`、`klient`、`kosong` 的 `ChatProvider` 接口）**已经具备良好的 provider 抽象**。真正的耦合集中在两个地方：

1. **`packages/oauth/`** — 认证/模型发现/用量管理的完整链路绑死了 Kimi
2. **首次启动体验** — 强制 Kimi OAuth 登录

解除绑定的关键不是重写代码，而是：
- 把 `managed:kimi-code` 从**唯一路径**降级为**选项之一**
- 把首次启动从**强制登录**改为**多选向导**
- 把 Kimi 专有 API 特性通过 **capability 门控**而非 provider 类型检查来访问
- 把内置服务改为**可插拔的 MCP 工具**

方案 B（标准解耦）是最推荐的路径——保持向后兼容，不破坏现有 Kimi 用户，同时允许新用户直接使用任意 OpenAI-compatible provider 而无需任何 Kimi 认证。
