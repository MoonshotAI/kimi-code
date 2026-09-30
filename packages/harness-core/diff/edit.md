# edit：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/edit/`（约 316 行 ts + 13 行 md：feature.ts 13 / tool.ts 131 / service.ts 121 / line-endings.ts 47）
- agent-core-v2：`src/app/edit/`（161 行：editService.ts 41 / fileEdit.ts 23 / fileEditService.ts 54 / textModel.ts 43）+ `src/agent/tools/edit/`（153 行 ts + 13 行 md：edit.ts 34 / editTool.ts 119）
- 蓝本关系：以 v2 DI 版为蓝本（第 16 轮迁移，文案/行尾逐字对齐）；path-access 为第 18 轮补接（os 决策⑥）。非 refact-237 第一批 human 蓝本域。

## 行为差异
### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| 架构形态 | App 域 DI 服务 `IFileEditService`（registerScopedService）+ Agent 域 `EditTool`（registerAgentToolService） | `createEdit({ workDir, host? })` agent tier 工厂，`useAgentTools` 注册 Edit 工具；service.ts 为纯函数 | Handoff 第 16 轮；工厂不进 preset（workDir 是宿主概念，createSpawn/createCompaction 先例，偏差④） |
| 文件读写通道 | 经 `IHostFileSystem` 端口读写（可为远程 runtime fs），执行前 `runtime.acquire(['fs'])` + generation 校验，失败回 `Runtime changed before execution. Retry the tool call.`（isError） | `node:fs/promises` 直读写；host 端口仅用于 `environment`（path-access 的 pathClass/homeDir 解析）；无 runtime lease/generation 概念 | os 工具组决策①（2026-09-29：runtime lease/generation 校验与 requiredRuntimeCapabilities 门控不迁——「宿主注入什么端口」即能力决策） |
| 工具注册门控 | `requiredRuntimeCapabilities: ['fs']`，runtime 无 fs 能力不注册 | 挂载即注册（spec freeze），host 未注入时 `createNodeOsHost()` 兜底 | 第 18 轮偏差⑥（createEdit/createShellCommand/createOs 缺省 `createNodeOsHost()`；第 22 轮用户在 agentsMdReminder 否决同类缺省但明确未要求改这里，记录在案） |
| 参数校验 | zod `EditInputSchema` 框架层校验（edit.ts:6-27） | 工具内容错解析，非法输入回 `invalid Edit arguments: <raw>` 文本（tool.ts:23-58） | wait-for 先例（第 16 轮） |
| 错误通道 | 全部失败路径 `isError: true`（old===new、notFound、notUnique、EISDIR、fs 异常） | 已标 `isError: true`，框架统一渲染 | 第 16 轮（WebSearch/WaitFor 先例）；A 步已落地（第 76 轮） |
| path-access 接入 | resolveExecution 内 `resolvePathAccessPath`，workspace = workDir + `workspaceCtx.additionalDirs` + skill catalog roots（editTool.ts:37-46） | `resolvePathAccessPath(args.path, { env, workspace: { workspaceDir: workDir, additionalDirs: [] }, operation: 'write' })`，PathSecurityError 转文本结果（tool.ts:103-116） | 第 18 轮⑤（edit 补接 path-access，默认策略；props 增 `host?`） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| 工作区视图 | additionalDirs 含会话附加快捷目录与 skill roots，工作区外绝对路径可依此放行 | `additionalDirs: []` 固定（tool.ts:108），props 无 additionalDirs | 配了附加目录的会话里编辑附加快捷目录内文件会被 path-access 拒绝；归属 edit props 扩展或 os 域收口（第 18 轮⑤编排者收口项之一，未单列遗留） |
| display / approval | `display: { kind: 'file_io', operation: 'edit', path, before, after }`、`approvalRule: literalRulePattern`、`matchesRule`、`ToolAccesses.readWriteFile`（editTool.ts:57-73） | 全部未迁 | 审批规则匹配与富展示缺失；归属 permission 域 #19（第 16 轮偏差③）；ACP diff 卡片已由 feature-acp 从工具参数派生重建（第 43 轮） |
| 检查顺序 | 先 resolvePathAccessPath（resolveExecution 阶段）再查 old===new（execution 内） | 先查 old===new（tool.ts:100）再做 path-access | 两错误同时成立时返回文案不同；可观察影响极小，无归属 |
| isError 模型侧感知 | 请求装配时 isError 结果前置 `<system>ERROR: Tool execution failed.</system>` 状态块 | 已消除——装配层经 `renderToolResultForModel` 前置同一状态块 | A 步已落地（第 76 轮） |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| 容错参数解析 | v2 框架 zod 拒绝即框架错误；harness-core 容错解析给模型可读文案 `invalid Edit arguments: <raw>`，模型可自行纠正重试（wait-for 先例的新架构约定） |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| config 节 | 无 | 无 | 已对齐 |
| workDir | `ISessionWorkspaceContext.workDir`（DI 注入） | 工厂 props `createEdit({ workDir })` 必传 | 人为设计（宿主概念 props 化） |
| host（fs/environment） | `IHostFileSystem` + runtime environment（DI） | props `host?: OsHost`，缺省 `createNodeOsHost()`；仅 environment 用于 path-access，fs 不走端口 | 人为设计（os 决策①⑥） |
| env 绑定 | 无 | 无 | 已对齐 |

## 工具 / 事件 / facade 面差异
- 工具：两侧均仅 `Edit` 一个工具。名称、`edit.md` 描述（cmp 逐字节一致）、参数 schema 四字段（path/old_string/new_string/replace_all，describe 文案逐字）已对齐；v2 经 zod 产出 schema 且 `replace_all` optional，harness-core 手写 JSON schema 且 `old_string` 带 `minLength: 1`，等价。
- 输出文案：`Replaced N occurrence(s) in <path>`、`No changes to make: …`、`old_string not found in …`（含尾随 `\n`）、`old_string is not unique …`、`… is not a file.` 全部逐字对齐；displayPath 均用用户原给 path。
- 行尾处理：`line-endings.ts`（detect/toModelTextView/materializeModelText）为 v2 `_base/text/line-endings.ts` 子集逐字移植；TextModel/applyEdit 逻辑逐字。
- 事件：两侧均无 Feature 事件。
- facade：v2 为 `IFileEditService.edit()`（DI 服务，App 域）；harness-core 无 facade（工具即全部产品面，`editFile`/`applyEdit`/`TextModel` 经包出口可被宿主复用）。

## 摘要
edit 是迁移保真度最高的小域之一：编辑算法（TextModel/applyEdit/行尾归一）、全部成功与错误文案、工具描述与参数 schema 均逐字对齐 v2。核心差异集中在执行环境而非编辑语义：v2 经 IHostFileSystem + runtime lease 可面向远程 runtime，harness-core 固定本地 node:fs 并以 host 端口只做 path-access 环境解析（os 决策①的既定取舍）。最大缺口是 additionalDirs 未接入（workspace 视图只含 workDir）；isError 框架通道已随 A 步落地（第 76 轮）；display/approvalRule 面按归属留待 permission 域。总体对齐程度：编辑语义完全对齐，执行环境语义按既定架构决策降级。
