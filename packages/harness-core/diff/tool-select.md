# tool-select：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/tool-select/`（335 行：feature.ts 68 / state.ts 128 / tool.ts 82 / resolver.ts 39 / index.ts 18）
- agent-core-v2：`src/agent/toolSelect/`（564 行：toolSelectService.ts 330 / dynamicTools.ts 101 / toolSelect.ts 35 / 两 reminder 接线服务 66 / flag.ts 16 / 接口 16）+ `src/agent/tools/select-tools/`（75 行）；refact-237 第一批蓝本 `src/human/tool-select/`（约 300 行：plugin.ts 48 / state.ts 129 / tool.ts 87 / resolver.ts 39）
- 蓝本关系：refact-237 第一批域，state/tool/resolver 以 human/tool-select 为蓝本近乎逐字移植；第 17 轮按用户选定方向修死工具（挂载期门控）。与 v2 DI 版的差异多为蓝本因素。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 挂载期门控 | 无挂载期分支：select_tools 恒注册（Feature `when` 不含 enabled），`shapeTools` 每请求按 enabled+policy 塑形 | `state.enabled()` 为 false 时只把 `options.loadable()` 工具原样注册（不 defer、不挂 select_tools、不挂 resolver 与事件）后早退（feature.ts:25-28） | 第 17 轮（用户报告死工具实跑事故，选定方向 1；agent-core `getTools` 会把 deferred 工具滤出请求——disabled 时仍 defer 等于工具彻底消失） |
| enabled 判定来源 | capability（`dynamically_loaded_tools && tool_use`）+ experimental flag `tool-select`（toolSelectService.ts:84-91） | props 回调 `enabled: () => boolean`，宿主自决；`isToolSelectEnabled(capability)` 助手保留供宿主使用 | 蓝本因素（human 同形态）+ 第 17 轮保持 props 形态 |
| schema 落地追踪 | reminder 总线 drain 时 `drainPendingToolSchemas()` 一次性清空 pending（总线保证注入即落地） | `schemaFlight` 按名记录本次 flight，`turn.drained` 确认落地后 `markSchemasLanded(names)` 只迁移本次名单（feature.ts:43-64） | 蓝本修正：human 蓝本 `markSchemasLanded()` 全量落地（flight 期间新增 pending 会被误标）；harness-core 更精确 |
| announcement 防重入 | 无（每 turn.started 调 `loadableToolsAnnouncement()`，pendingAnnouncement 覆盖式更新） | `announcementInFlight` 门：一条 announce 未落地前不重发（feature.ts:34-42） | 蓝本修正（remind 被动通道下的必要防护） |
| 注入通道 | reminder 总线 `register(LOADABLE_TOOLS_VARIANT, {isNewTurn} → …)` 与 `register(DYNAMIC_TOOL_SCHEMA_VARIANT, …)`，gate 时直接进入下一请求 | `agent.on('turn.started')` / `agent.on('tool.done')` / `agent.on('turn.drained')` + `agent.remind` 同 key（`loadable-tools` / `dynamic-tool-schemas`），drain 落账 | 横切约定（remind 取代 reminder 总线；用户 2026-09-27 决策） |
| 事件订阅 | human 蓝本订 `tool.done` + `tool.failed` 推 schema；v2 DI 由总线驱动无订阅 | 只订 `tool.done` | 第 26 轮 tool 终局事件合一（failed/aborted 并入 `tool.done{outcome}`），语义等价 |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| loaded/announced 状态载体 | 从历史派生：`collectLoadedDynamicToolNames(history)` + `foldAnnouncedToolNames(history)` + durable `toolSelectPendingLoadedKey`——重启/remount 后已加载集合与已宣告集合保留 | 全内存 `pending/landed/announced` 三 Set（state.ts:55-58），remount/重启后清零：全部 loadable 重新 announce，历史中仍存在的 schema 消息对应的工具被守卫要求重新 select | 蓝本因素（human 同缺陷）；跨重启保真度损失，未单列归属 |
| toolPolicy 集成 | `loadableToolNames` 过滤 `toolPolicy.isToolActive`；select_tools 可见性走 `isToolActiveForDisclosure`；策略翻转后已加载工具回 `inactiveLoadedToolOutput`（"was loaded but is no longer active"） | 无政策层：`loadable()` 全权由宿主给；守卫只有 `notLoadedToolOutput` 一种（"available but not loaded"） | sessionToolPolicy 归属仍挂起（permission 或 profiles，第 19/29 轮遗留）；inactive 文案无对应场景 |
| MCP 断连提示 | `describeMissingTool`：已加载但注册表消失的工具按 isMcpToolName 给 "MCP server is currently disconnected…" / "no longer registered" 两文案 | 无（deferTool 的 executor 恒在，工具不会从执行侧消失） | spec freeze 语义下工具集挂载冻结（横切约定），v2 动态注销场景不存在；mcp 域迟到工具走 deferred 通道已是新架构等价物 |
| disabled 时历史剥离粒度 | `stripDynamicToolContext` 同时剥离 announcements（origin 判定）与 schema 消息的 tools 字段 | resolver 只剥 system 消息的 tools 字段（disabled 时 kept=[]），announcement 用户消息保留在历史 | 模型在 disabled 后仍看到历史宣告文案（但工具已直连可用，文案仅噪声）；影响小，无归属 |
| isError 通道 | 失败输出带 isError（select_tools 全部 unknown 时 `isError: true`；guard 输出 isError；human 蓝本同） | 已切回（全部 unknown 时按 v2 条件标记 `isError: true`；guard 输出同标） | A 步已落地（第 76 轮） |
| context.reset 重置 | human 蓝本订 `context.reset → state.reset()`（compaction 后清空）；v2 DI 订 CompactionCompleted 清 pending + ContextSpliced 清未落地 pending | feature 无重置订阅（state.reset() 存在但无调用方） | 新架构 compaction 换分支后宿主重挂 agent、setup 重跑自然重建状态，语义大体覆盖；同分支内无重置路径属蓝本遗留，影响极小 |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| schemaFlight 精确落地 | 只把本次 flight 内的工具标记为 landed；flight 期间新 select 的工具不会被误标（human 蓝本全量落地，v2 DI 总线 drain 语义等价但无并发 flight 概念） |
| announcementInFlight | 防止 announce 未落地时重复注入（v2 由总线 reconcile 天然防重） |
| 挂载期门控 | disabled 时 loadable 工具直连可用且 select_tools 不可见——修复 v2 同款场景下「只见 select_tools、调用报错、无任何正常工具」的实跑事故（v2 由 shapeTools 规避，harness-core 在 spec freeze 下必须挂载期决策） |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| experimental flag | `tool-select` flag（env `KIMI_CODE_EXPERIMENTAL_TOOL_SELECT`，默认 false，surface core） | 无（props `enabled` 全权） | 人为设计（蓝本形态；flag 体系不迁） |
| `loadable` 工具来源 | 工具注册表 `disclosure === 'deferred'` 且 policy active 的条目 | props `loadable: () => readonly ToolDefinition[]` | 人为设计（宿主注入即能力；v2 注册表 disclosure 概念不迁） |
| capability 判定 | 内置（`profile.getModelCapabilities()`） | `isToolSelectEnabled(capability)` 导出助手，宿主自接 | 已对齐（判定式逐字：`dynamically_loaded_tools === true && capability.tool_use`） |
| config 节 / env | 无节；flag env 见上 | 无 | 已对齐 |

## 工具 / 事件 / facade 面差异
- 工具：`select_tools` 名称、description、参数 schema（`names` array minItems 1、`additionalProperties: false`，与 v2 zod strict 输出一致）逐字对齐；输出文案 `Loaded: …` / `Already available: …` / `Unknown tool: …` / `Provide at least one tool name in names.` / `select_tools is not available for the current model.` 逐字对齐；deferTool 守卫文案逐字对齐；全部 unknown 时 `isError: true` 标记已按 v2 条件对齐。
- 事件：两侧均无 Feature 事件（注入经 reminder 消息，不暴露事件面）。
- facade：v2 为 `IAgentToolSelectService`（enabled/shapeTools/shapeHistory/load/drainPendingToolSchemas/loadableToolsAnnouncement 六方法，DI 内部消费）；harness-core 无公开 facade——`ToolSelectState`（enabled/isLoadable/isLoaded/load/pendingSchemas/announcement/mark*/reset）经包出口可被宿主复用。

## 摘要
tool-select 的核心机制（select_tools 工具契约、defer 守卫、announce/schema 双通道注入、resolver 历史剥离）与 v2 语义对齐，第 17 轮的挂载期门控修复了 spec freeze 下的死工具事故（v2 靠每请求 shapeTools 规避的同类问题）。最大差异是状态载体：v2 从历史派生 loaded/announced 集合并有 durable pending，harness-core 继承 human 蓝本的全内存设计，重启后全量重 announce 且已加载工具需重新 select。最大缺口是 toolPolicy 集成（active/disclosure 过滤与 inactive 文案）无政策层承接，归属随 sessionToolPolicy 挂起；schemaFlight 与 announcementInFlight 是超出蓝本的精确性增强。
