# Model Catalog Service 目标架构定稿

本文是**概念定稿**：不引用当前代码结构、不预设迁移路径。只描述目标形态、依赖方向和决策记录。

## 目录

- [结论](#结论)
- [第一性原理](#第一性原理)
- [Service 拆分概览](#service-拆分概览)
- [统一的配置读取模型](#统一的配置读取模型)
- [关键场景](#关键场景)
- [派生交互映射](#派生交互映射)
- [依赖方向与边界](#依赖方向与边界)
- [决策记录](#决策记录)

## 结论

目标架构里：

- `ModelCatalogService` 管“模型 / provider 目录”这一份**配置派生 aggregate**：列出可见模型、列出 provider 及其凭据状态、读取单个 provider。
- 同一个 Service 同时承担该 aggregate 的**命令**：设置默认模型、刷新受管 Kimi provider 的模型清单。

**这个 domain 不需要拆成 query / command / runtime 三个 Service。**

- 目录读取只有三个方法、且都基于同一份配置真相，不构成多 scope 的查询模型，因此不引入单独的 Query Service。
- 命令只有两个、且与读取共用同一份配置读取入口，拆开只会把共享的配置解析拆成两份。
- 该 domain 没有事件驱动的活状态、没有状态订阅、没有 per-id 运行时投影，因此**不存在 Runtime 角色**。

接口定义见 `modelCatalog.ts` 的 `IModelCatalogService`；本文只承载跨 Service 的概念叙述。

## 第一性原理

### 1. 一个 aggregate 只由一个 Service 拥有

“模型 / provider 目录”是一个独立的 aggregate：

- 它描述“当前这份配置里有哪些模型别名、哪些 provider、各自的凭据是否就绪”。
- 它的真相是 `KimiConfig`（models / providers / defaultModel）。
- 它不拥有 Session、不拥有 Workspace，也不被它们拥有；其他 aggregate 只通过模型 id / provider id 引用它。

因此目录的读取和写入由同一个 Service 承载，不把“配置真相”分散到多个 owner。

### 2. 命令 / 查询 / 运行时状态分开（按需要引入）

按 service-skill 的角色表，本 domain 实际只用到两类：

| 类型 | 关注 | 归属 |
|---|---|---|
| Query | 列出模型、列出 provider、读取单个 provider | `ModelCatalogService`（读取方法） |
| Command | 设置默认模型、刷新受管 provider 模型清单 | `ModelCatalogService`（写入方法） |
| Runtime | 活状态、运行中信息 | **无**（本 domain 没有活状态） |

按 [Domain decomposition](../../../../../packages/agent-core/src/services/AGENTS.md) 的规范：“不是每个 domain 都需要五件套，仅当某角色有明确 owner 且契约非空时才引入”。本 domain 的读取契约是“基于同一份配置的平坦目录”，不是多 scope 查询，因此不为它单独开 Query Service。

### 3. 读取不写入，写入不返回查询模型

边界保持干净：

- 读取方法（list / get）只读配置，不调用任何写入原语。
- 写入方法（set / refresh）调用配置的写入原语，返回**命令结果**（被设置的模型、刷新产生的变更摘要），不返回 list / search 形态的查询模型。

这条边界是“是否需要拆分”的唯一硬指标：只要读取不写入、写入不伪装成查询，单 Service 就是清晰的。

### 4. 凭据状态是派生，不是活状态

provider 的 `has_api_key` / `has_oauth_token` / `status` 是在读取时由“配置 + 已缓存的 OAuth token”**当场派生**的快照：

- 它不是事件流驱动的活状态，没有 `onDidChange` 订阅。
- 它不写入真相，只是读模型上的一个派生字段。

因此它属于 Query 的派生字段，**不构成 Runtime Service**。

### 5. Service 层解析业务标识

`providerId` / `modelId` 的有效性校验（不存在则抛 `ProviderNotFoundError` / `ModelNotFoundError`）、受管 Kimi provider 的识别、OAuth token provider 的解析，都在 Service 层完成；transport 层只做参数映射，不承载这些业务规则。

## Service 拆分概览

| Service | 一句话职责 | 角色 |
|---|---|---|
| `IModelCatalogService` | 模型 / provider 目录的读取，以及默认模型与受管 provider 模型清单的写入 | query + command（合并） |

> 只有这一个 Service。不引入 `IModelCatalogQueryService`，不引入 `IModelCatalogRuntimeService`。
> 共享类型（`ModelCatalogItem` / `ProviderCatalogItem` / `ProviderCredentialState` / 错误类型）与协议映射函数见 `modelCatalog.ts`。

模式参考：

- 命令侧对齐 [`command-service.md`](../../reference/patterns/command-service.md)：本 domain 的写入是“配置 update + 受管刷新”，不是 aggregate 的 create/archive/purge 生命周期，因此只取其中的“业务标识解析 + 唯一写入入口”两点，不强行套用 archive/restore/purge。
- 查询侧对齐 [`query-service.md`](../../reference/patterns/query-service.md) 的“读取不依赖运行时、不写入”原则；但不套用其多 scope `list()` 骨架，因为目录读取没有 scope / 分页 / 归档维度。

## 统一的配置读取模型

目录读取和写入共用**同一份配置真相** `KimiConfig`：

```text
KimiConfig
  ├─ models        : { [alias]: ModelAlias }      // 模型别名 → provider / model / capabilities
  ├─ providers     : { [id]: ProviderConfig }     // provider → type / baseUrl / apiKey / oauth
  ├─ defaultModel  : alias | undefined
  └─ defaultThinking: boolean | undefined
```

所有读取方法都先取得这一份配置，再做投影：

```text
listModels()    → read config → map(models, toProtocolModel)
listProviders() → read config → map(providers, toProtocolProvider + credential)
getProvider(id) → read config → toProtocolProvider(id) + credential
```

写入方法也先读配置、再写回：

```text
setDefaultModel(modelId)
  → read config → 校验 modelId 存在 → 写 defaultModel → 返回被设置的模型

refreshOAuthProviderModels()
  → read config → 拉取受管 Kimi provider 模型 → 计算 next config
  → 写回 providers/models/defaultModel → 返回变更摘要
```

> `getKimiConfig` / `setKimiConfig` / `removeKimiProvider` 是**底层配置的读写原语**（经由 core 的 in-process 通道），不是 `IModelCatalogService` 暴露的方法。Service 把它们作为实现细节，对外只暴露目录语义的读取和命令。

## 关键场景

### 场景 A：列出可用模型

```ts
modelCatalogService.listModels();
```

内部解析：`read config → Object.entries(models).map(toProtocolModel)`。纯读取，无写入。

### 场景 B：列出 provider（含凭据状态）

```ts
modelCatalogService.listProviders();
```

内部解析：`read config → 对每个 provider 派生 hasApiKey / hasOAuthToken → toProtocolProvider`。纯读取，无写入；凭据状态为当场派生，非活状态。

### 场景 C：设置默认模型

```ts
modelCatalogService.setDefaultModel(modelId);
```

内部解析：`read config → 校验 modelId → setKimiConfig({ defaultModel }) → 返回 { default_model, model }`。写入；返回的是命令结果（被设置的单个模型），不是查询模型。

### 场景 D：刷新受管 Kimi provider 的模型清单

```ts
modelCatalogService.refreshOAuthProviderModels();
```

内部解析：`read config → 解析受管 Kimi provider 的 OAuth token → fetchManagedKimiCodeModels → 计算 next config → 必要时 removeKimiProvider + setKimiConfig → 返回 { changed, unchanged, failed }`。写入；返回的是刷新的变更摘要，不是查询模型。

## 派生交互映射

| 用户交互 | 对应 Service 方法 | 角色 |
|---|---|---|
| 查看可用模型列表 | `ModelCatalogService.listModels()` | query |
| 查看 provider 列表 | `ModelCatalogService.listProviders()` | query |
| 查看单个 provider 详情 | `ModelCatalogService.getProvider(id)` | query |
| 切换默认模型 | `ModelCatalogService.setDefaultModel(modelId)` | command |
| 刷新受管 Kimi provider 模型 | `ModelCatalogService.refreshOAuthProviderModels()` | command |

## 依赖方向与边界

概念分层（不引用任何具体实现层 Service）：

```text
Application Service
  IModelCatalogService          (query + command, 合并)

Domain / Persistence
  KimiConfig (真相)             (models / providers / defaultModel)
  受管 Kimi OAuth 配置           (managed-kimi-code-oauth)

Infrastructure
  core 的 in-process 配置通道     (getKimiConfig / setKimiConfig / removeKimiProvider)
  受管模型拉取                   (fetchManagedKimiCodeModels)
  OAuth token provider           (resolveOAuthTokenProvider / getCachedAccessToken)
```

依赖关系：

```text
IModelCatalogService → KimiConfig 读写原语 (经 core in-process 通道)
IModelCatalogService → 受管 Kimi OAuth  facade (token provider / fetch models)
```

禁止的边界：

```text
IModelCatalogService ⇄ 任何 transport / RPC 展示逻辑
IModelCatalogService → 其他 domain 的 Service   (目录不依赖 Session / Workspace / Tool)
```

读取路径只读配置原语，写入路径只调配置写入原语；不在读取中混入 `setKimiConfig`，也不在写入中返回 list 形态的数据。

## 决策记录

- **DR1：目录是配置派生的单一 aggregate。** 真相是 `KimiConfig`；读取和写入由同一个 `ModelCatalogService` 拥有，不分散 owner。
- **DR2：不拆 Query / Command Service。** 读取只有三个方法、基于同一份配置、无多 scope 查询；写入只有两个、与读取共用配置入口。拆开只会复制共享的配置解析，不增加清晰度。拆分的硬指标（读取是否写入、写入是否伪装成查询）当前均为“否”。
- **DR3：不存在 Runtime Service。** 本 domain 无事件驱动活状态、无状态订阅、无 per-id 运行时投影。provider 凭据状态是读取时的派生快照，不是活状态。
- **DR4：读取不写入，写入不返回查询模型。** 读取方法只调配置读取原语；写入方法返回命令结果（被设置的模型 / 刷新变更摘要），不返回 list / search 形态数据。这是“是否需要拆分”的唯一硬指标。
- **DR5：`getKimiConfig` / `setKimiConfig` / `removeKimiProvider` 是底层原语，不是 Service 方法。** Service 把它们作为实现细节，对外只暴露目录语义的读取与命令。
- **DR6：业务校验在 Service 层。** `providerId` / `modelId` 存在性、受管 Kimi provider 识别、OAuth token provider 解析均在 Service 层完成；transport 只做参数映射。
- **DR7：受管 Kimi provider 刷新是命令，不是查询。** 它会写回配置（可能先 removeKimiProvider 再 setKimiConfig），并返回变更摘要；即使“无变更”也属于命令结果，不伪装成读取。
