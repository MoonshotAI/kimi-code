# feature-http：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/feature-http/`（5214 行：feature.ts 119 + server.ts 170 + index.ts 15 + route/ 350 + route-builtin/ 2219——model-catalog 736 / sessions 489 / config 209 / prompts 200 / gui-store 161 / web-assets 103 / agents 87 / features 61 / tools 57 / meta 46 / index 37 / shutdown 20 / health 13 + route-features/ 2341——interaction 456 / mcp 432 / plugin 252 / task 229 / models-dev 211 / skill 169 / status 111 / sessionExport 109 / remote-control 105 / sessionTitle 80 / compaction 60 / index 44 / goal 43 / btw 40）
- agent-core-v2：v2 无一一对应物；路由行为蓝本是 kap-server REST——`packages/kap-server/src/routes/`（sessions.ts 1224 + prompts.ts 659 + tasks.ts 342 + questions.ts 306 + approvals.ts 200 + sessionExport.ts 197 + remoteControl.ts 122 + meta.ts 64 + skills.ts 与 modelCatalog.ts 的相关部分）+ 基础设施（envelope.ts 33 + protocol/error-codes.ts + middleware/defineRoute.ts 205 + validate.ts + auth.ts 90 + routes/action-suffix.ts 43 + action-dispatch.ts 74 + error-handler.ts 42 + request-id.ts）
- 蓝本关系：feature-http 是 harness-core 自有传输层（express 5），refact-237 第一批落地（Handoff L7），非 refact-237 第一批 human 蓝本；本任务（feat-271）增补的路由以 kap-server 同名路由为行为蓝本：title/generate（第 12 轮，L197/L235）、export（第 20 轮，L255）、remote-control（第 39 轮，L317）、catalog（第 56 轮，L96/L207/L346）。action-suffix 解析器（route/action-suffix.ts）为 v2 `routes/action-suffix.ts` 逐字移植（仅变量名差异）

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
| --- | --- | --- | --- |
| 传输框架与请求校验 | Fastify 5 + zod schema（defineRoute preHandler 校验 body/params/query，校验失败 40001 + `details[{path,message}]`）+ OpenAPI 文档（/openapi.json、@fastify/swagger） | express 5 + 手写校验助手（route/http.ts 的 `param`/`readAgentId`/`readUserMessage`/各 `read*Input`），无 schema 层、无 OpenAPI | refact-237 第一批既有形态（L7）；本任务各轮沿用（L255/L317/L346） |
| HTTP 状态码语义 | **一律 HTTP 200** + envelope（错误码在 body `code`；error-handler.ts:33 `reply.status(200)`；例外仅 import 201 与导出二进制流） | **真实 HTTP 状态码**（400/404/409/500/502 + create/fork/import 201）+ 同形 envelope `{code,msg,data,request_id}` | 各轮收口一致采用（L255「缺席 409 / 40924」、L317、L346）—— envelope 形状对齐、状态语义有意分叉 |
| 路由注册机制 | kap-server 集中注册（registerApiV1Routes.ts 226 行全量挂接） | `HttpRoutes` collection + `useHttpRoute(route, priority)` 贡献点：任何 feature 可在任意 tier 挂路由，handler 经 `asUnit` 包裹使内部可用 `useApp()`/`inject()`；同 path 多 handler 时 server 取**最后注册者**生效（server.ts:120-131）；`HttpRef` facade 暴露 `route/listen/close/app/origin` | feature.ts:34-49；asUnit 先例在 L203 被引用（feature-http feature.ts:44-47） |
| facade 缺席显式 409 | v2 DI 服务恒在，无「feature 未安装」分支 | 各路由 `tryResolve`/`inject` 可选探测，未安装返回专属 409xx：`SESSION_EXPORT_UNAVAILABLE` 40936、`REMOTE_CONTROL_UNAVAILABLE` 40937、`MODELS_DEV_UNAVAILABLE` 40938、`SESSION_BTW_UNAVAILABLE` 40931、`INTERACTION_UNAVAILABLE` 40932、`TASK_UNAVAILABLE` 40933、`SKILL_CATALOG_UNAVAILABLE` 40934、`GOAL_UNAVAILABLE` 40935（均 HTTP 409 + 固定文案 `'<x> is unavailable (<x> feature is not installed)'`） | 第 20 轮先例（L255「facade 经 inject 可选解析，缺席 409 / 40924」），第 39/56 轮沿用；码值第 61 轮改号（见「错误码号段约定」行） |
| session action 集 | 8 个：fork/compact/undo/abort/btw/**restore**/archive/delete（sessions.ts:856-886） | 10 个：fork/abort/**pause**/**continue**/delete/**update**/compact/undo/btw/archive（route-builtin/sessions.ts 与 route-features/compaction.ts、route-features/btw.ts）；restore 未迁；pause/continue 对应 `agent.pause()/continue()` 命令面 | pause/continue/update 为新增能力（见「新增」表）；restore 缺口见「简化」表 |
| RESTful 增补 | v2 改/删走 `POST /sessions/{id}:update`（实为 POST `/sessions/{id}/profile`）与 `:delete` action | 增补 `PATCH /sessions/:id` 与 `DELETE /sessions/:id`（route-builtin/sessions.ts），同时保留 `:update`/`:delete` action 兼容 | 新增（见「新增」表） |
| prompt 提交面 | 富提交：content + prompt_id（预约留、冲突 40927）+ skills 捆绑 + profile/model/thinking/permission_mode/disabled_tools + steer 标志 + 媒体附件/文件引用解析 + 等待 launched + 返回 prompt 快照 `{prompt_id,user_message_id,status,content,created_at}`（prompts.ts:191-377） | 简提交：`{content, prompt_id?, agent_id?}` → `agent.submit(message,{promptId,origin:{kind:'user'},tracked:true})`，返回 `{prompt_id,agent_id,submitted:true}`（route-builtin/prompts.ts:8-43） | 能力缺口（见「简化」表） |
| notify / remind | v2 kap-server **无对应 REST 路由**（grep 全 src 无 notify/remind 路由） | 新增 `POST /sessions/:id/notify`、`POST /sessions/:id/remind`（remind 支持可选 `{key}`）（route-builtin/prompts.ts:127-188） | 新增（见「新增」表） |
| task action 命名 | `:cancel` + `:detach` 两 action（tasks.ts:162-166） | 仅 `:stop` 单 action（route-features/task.ts:29），调 `TaskRef.stop(id,'Aborted by the user')` | 底层 facade 差异的连带（TaskRef 无 detach 面）；wire 名不一致属保真度损失 |
| catalog 路由面 | `GET /catalog/providers`、`GET /catalog/providers/{catalog_id}`、`POST /providers:{refresh,refresh_oauth,import_catalog,import_registry}` 四 action + providers/models 管理面（GET/POST/PUT/DELETE /providers*、GET /models*） | 仅 browse 两路由 + import 两 action（`:import_catalog`/`:import_registry`，201 `{provider(s),models_imported}`，body/字段 snake 对齐）；`:refresh`/`:refresh_oauth` 与 providers/models 管理面不迁 | 四项定稿③+设计要点⑥（L96/L207「JSON 形状保持 v2 snake 字段」；:refresh 系不在定稿范围） |
| models-dev 错误码映射 | 五码：CATALOG_UNAVAILABLE 50004 / CATALOG_ENTRY_NOT_FOUND 40417 / CATALOG_IMPORT_INVALID 40004 / REGISTRY_IMPORT_INVALID 40005 / PROVIDER_OAUTH_MANAGED 40003（modelCatalog.ts:723-729） | 同五码同数值 + 新增 `config.unavailable` → 40938；`modelsDev.catalog_unavailable` 另配 HTTP 502（route-features/models-dev.ts:159-185） | 第 56 轮（L346；HTTP 502 为 harness-core 状态语义的体现） |
| 错误码号段约定 | 全部码在同一数值空间混排，无语义/新增分区 | 同义码与 kap-server 同号同名；本地新增码（kap 无对应语义）一律取 kap-server 未占用的号（kap 409xx 占至 40930、500xx 占 50001/50003/50004），无撞号 | 第 61 轮：用户指出 5 码撞号不同义（40901 SESSION_EXISTS↔SESSION_BUSY、40924/40925/40926 facade 缺席码↔CAPABILITY_INSTALL_IN_PROGRESS/CAPABILITY_UNSUPPORTED/RUNTIME_UNAVAILABLE、50001 SESSION_EXPORT_FAILED↔INTERNAL_ERROR），4 个 kap 无对应语义的新增码改号 40901→40939、40924→40936、40925→40937、40926→40938；第 62 轮用户澄清「相同语义错误码要一致，最终无两服务并存」——50001 实为同义（kap 对导出失败即返回 INTERNAL_ERROR，sessionExport.ts:192），撤销 50005 改号、`SESSION_EXPORT_FAILED` 改名归位 `INTERNAL_ERROR` 50001；kap-server 后续占号需对齐（第 58 轮起新增码即在 40931+ 空段顺延） |
| server 生命周期 | kap-server 进程启动即绑定端口（fastify listen） | `createHttp({server?,listen?,prefix?})`：自有 server 时 `useReady(listen)`（未就绪不服务）+ pushCleanup close；外部注入 `options.server` 时只挂路由不管生命周期（feature.ts:68-90） | 宿主可注入既有 Http 共享端口（见「新增」表） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
| --- | --- | --- | --- |
| 鉴权与安全中间件 | `createAuthHook`：bearer 校验、401 + code 40101、失败限流 429、hostname/origin 校验、security headers、request logging（middleware/auth.ts、origin.ts、hostnames.ts、securityHeaders.ts、rateLimit.ts） | **零中间件**（仅 `express.json()`，server.ts:32） | 任何能访问端口的人可全量操作；第 39 轮偏差④在案（L317「feature-http 补 auth 是独立议题」），remote-control 域安全风险由此放大 |
| validation 细节 | zod 失败返回 `details: [{path,message}]` 数组 + msg 取首条（validate.ts:27-47） | 手写校验仅 msg，无 details 字段 | 客户端无法按 path 定位错误；未在案 |
| request_id 生成 | 缺 `x-request-id` 时 `parseOrGenerateRequestId` 生成（request-id.ts） | 缺省返回 `''`（route/http.ts:46-49） | 链路追踪断裂；未在案 |
| error envelope `stack` 字段 | `errEnvelope(code,msg,id,stack)` 携带堆栈（envelope.ts:26-32） | sendErr 无 stack | 排障信息减少；未在案 |
| 未捕获错误兜底 | error-handler 统一 200 + 50001 envelope（error-handler.ts:32-40） | `next(error)` 走 express 默认错误页——**HTML 500，非 envelope**（server.ts:127-129） | 客户端遇到非 JSON 响应；未在案 |
| 冷会话可达性 | `resumeSessionById`/`ISessionIndex`：冷（未激活）会话可恢复后操作（status/prompts/approvals/questions/title/btw 等） | `useApp().get(sessionId)` 仅查活表，冷会话一律 40401；list/get/PATCH/DELETE/archive/fork/delete 经 `app.space` 支持冷会话元数据，export 经 `app.space.get` + `sessionDir` 端口同样支持冷会话（features/sessionExport/feature.ts:40） | 重启进程后历史会话不可经 REST 做 title/status/prompt 等活表操作；未在案（v2 的 resume 通路属 kap-server 装配层能力） |
| sessions list 分页与过滤 | before_id/after_id 游标、page_size（默认 20）、busy、include_archive、exclude_empty、archived_only、workspace_id 过滤（sessions.ts:101-129） | 全量返回，恒 `has_more:false`，无任何 query（route-builtin/sessions.ts） | 大账户下性能与功能缺口；未在案 |
| session wire 形状 | 完整 Session schema：id/workspace_id/title(恒 string)/created_at/updated_at/archived/archived_at/busy/main_turn_active/pending_interaction/last_turn_reason/last_prompt/metadata{含 cwd}/agent_config/usage/permission_rules/message_count（sessions.ts:1021-1047） | 精简 SessionView：`{id,title?,workspace_id?,metadata?,archived?,archived_at?,agent_ids[]}`（route-builtin/sessions.ts） | 客户端拿不到 busy/timestamps/usage 等；未在案 |
| session create 语义 | 要求 `workspace_id` 或 `metadata.cwd` 二缺一否则 40001；经 ISessionManager 建会话并发布 SessionCreated；200 返回完整 wire（sessions.ts:188-257） | `app.open({session_id?,title?,workspace_id?,metadata?})` 无 cwd/workspace 校验；201 返回 `{id,agent_ids}`；重复 session_id → 409 + SESSION_EXISTS 40939（v2 无此场景——id 由 server 生成） | 语义收窄 + 状态码 200→201 |
| title/generate 冷会话 | resumeSessionById 可恢复冷会话后生成（sessions.ts:556-563） | 仅活表 session（route-features/sessionTitle.ts） | 冷会话 40401；40923 文案逐字一致（'…no managed OAuth login, no prompt yet, or the backend request failed'） |
| export 断连中止 | 客户端断连 abort 导出（exportAbort + onResponseClose + 清理临时目录，sessionExport.ts:64-96）；传 hostIdentity.version/desktopVersion | 无 abort 接线；version 由 createSessionExport props 管理（第 20 轮设计）；临时目录随流关闭清理 | 大导出被断开时浪费 IO；错误面：v2 → 200+50001，harness-core → 500+50001（同码同义，状态码语义分叉） |
| prompts 提交能力 | 见「人为设计」行：skills/profile/model/thinking/permission_mode/disabled_tools/steer/媒体附件/prompt_id 冲突 40927/等待 launched/prompt 快照响应 | 全部不迁；返回 `{prompt_id,agent_id,submitted:true}` | 远程客户端无法使用技能捆绑与模型切换；未在案（feature-http 定位为轻量传输层） |
| prompts 列表 | `GET /sessions/{id}/prompts`：active + queued 快照（prompts.ts:165-189） | 无此路由 | 队列不可观测 |
| tasks wire 保真 | kind 按 AgentTaskInfo 映射（process→bash/agent→subagent/question→tool）；run_in_background=detached；携带 command/model/thinking_effort/agent_id/subagent_type/parent_tool_call_id；`with_output` 经 `readOutput` 可读落盘输出（tasks.ts:234-315） | kind 恒 `'tool'`、run_in_background 恒 true、无上述扩展字段；output 仅内存 `record.output` 尾部切片（route-features/task.ts:210-229） | 任务类型与归属信息丢失；`:cancel`/`:detach` 改名为 `:stop`（detach 无底层面） |
| status 细节 | model 缺省时回退 defaultModel 查 catalog 得 maxTokens（sessionLegacyService.ts:84-87,126-135）；thinking_level = `getEffectiveThinkingLevel()` | 无 defaultModel 回退（`main.config?.model.maxInputSize ?? maxContextSize ?? 0`）；thinking_level = `config.thinking.effort ?? 'off'`（route-features/status.ts:60-67） | 未绑模型时 max_context_tokens/context_usage 缺失；busy 判定语义基本等价（loop running / 有 running task / compaction 非 idle） |
| undo 消息投影 | created_at = `sessionCreatedAtMs + index`（sessions.ts:1098-1116 + messageProjection.ts:127-147）；tool_result 带 `is_error:true`（msg.isError 通道） | created_at 取 `meta.createdAt`，缺省 **`new Date(index)`（1970 纪元 + index 毫秒）**（route-builtin/sessions.ts）；tool_result 已带 `is_error`（`ToolMeta.isError` 通道） | 无 meta 的历史消息时间戳为 1970 年；is_error 已随 A 步落地（第 76 轮） |
| questions/approvals 冷会话与 session 校验 | resumeSessionById 恢复冷会话；session 不存在 40401 | 活表查找；interaction feature 未装 → 40932 | 冷会话不可答；wire 视图（approvalView/questionView）与 v2 `toWireApproval`/`toWireQuestion` 逐字段一致 |
| remote-control 守卫 | 非 loopback 绑定时 staticEnableError → 40001（start.ts:447-448） | 不迁（详见 feature-remote-control.md；Handoff「kap-server 未传」与代码不符） | 非 loopback 部署下失去明确报错 |
| v2 路由未覆盖清单（feature-http 路由族对应面） | `GET/POST /sessions/{id}/profile`（agent_config 写）、`GET/POST /sessions/{id}/children`、`GET /sessions/{id}/warnings`、`POST /sessions/{id}:restore`、`POST /sessions/{id}/skills/{tail}:activate`、`GET /workspaces/{id}/skills`、`GET /meta`（server_version/capabilities/flags/features）、`/openapi.json` | 均无对应路由（profile 的 title/metadata 部分由 PATCH 覆盖；/features 反射是另一种形状） | 客户端依赖这些面时不可迁移；WS `/api/v3/ws` 实时推送面整体不属于 REST 对比范围，但注意 feature-http 无任何推送通道，轮询是唯一手段 |

### 新增 / 更强
| 差异点 | 说明 |
| --- | --- |
| `POST /sessions/:id/notify` / `POST /sessions/:id/remind` | v2 无 REST 对应；remind 支持可选 `{key}` 幂等键（route-builtin/prompts.ts:127-188） |
| agents 管理面 | `GET /sessions/:id/agents`、`GET /sessions/:id/agents/:agent_id`（含 status）、`DELETE .../agents/:agent_id`（route-builtin/agents.ts）；v2 无对应 REST |
| pause / continue action | `POST /sessions/:id:pause` / `:continue`（v2 REST 无），直调 agent 命令面 |
| RESTful PATCH/DELETE | `PATCH /sessions/:id`、`DELETE /sessions/:id`，v2 只有 action 形式 |
| status 路由 `pending_interaction` | 'none'/'approval'/'question' 三态（route-features/status.ts:15,101-111）；v2 status 无此字段（该信息在 v2 的 session wire 上） |
| `GET /features` 反射 | app/session/agent 三层 feature 名单树（route-builtin/features.ts）；v2 的对应物是 `/meta` 的 features（IFeatureManager 单元 name/state/meta），形状不同且含 fiber 状态 |
| 路由贡献点 + server 注入 | `useHttpRoute` 使任何 feature 可挂 REST（remount 自动摘挂）；`createHttp({server})` 可与宿主共享同一 HTTP 端口；v2 路由只能改 kap-server 源码 |
| facade 缺席显式 409xx | 见「人为设计」表；v2 无此语义层 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
| --- | --- | --- | --- |
| 监听 | CLI/opts 指定 port/host；暴露分类（loopback 等）影响 auth/RC 行为 | `createHttp({ listen?: { port?, host? } })`：port 默认 0（随机）、host 默认 127.0.0.1（server.ts:74-77） | 人为设计（宿主 props 化） |
| 路由前缀 | 固定 `/api/v1`（registerApiV1Routes.ts:196） | `prefix?` 默认 `/api/v1`（feature.ts:79；route-builtin/index.ts） | 已对齐 |
| 鉴权 token | rpcToken/authTokenService + password hash（start.ts:185-191） | 无 | 简化（在案，独立议题） |
| CORS/hostname/security headers | origin/hostnames/securityHeaders 中间件 | 无 | 简化（未在案） |
| 请求日志 | requestLogging + requestLog | 无 | 简化（未在案） |
| config 节 / env / flag | 路由层无 config 节； kap-server 进程级有 CLI/env | feature-http 无 config 节、无 env 绑定、无 experimental flag | 已对齐（路由层本就无配置面） |
| JSON body 解析 | fastify 内建 | `express.json()`（server.ts:32） | 已对齐 |

## 工具 / 事件 / facade 面差异
- 工具：两侧均无工具。
- Feature 事件：feature-http 无自有 Feature 事件；v2 kap-server 的 SessionCreated 等事件走 IEventService/WS 推送，feature-http 无推送通道。
- facade：`HttpRef`（`{app, origin, route, listen, close}`）为新增；内置路由消费各域 facade 均可选探测（缺席 409xx）：`SessionTitleRef`、`SessionExportRef`、`RemoteControlRef`、`ModelsDevRef`、`CompactionRef`、`UndoRef`（agent-core builtin）、`BtwRef`、`InteractionRef`、`TaskRef`、`SkillCatalogRef`、`GoalRef`、`PermissionRef`、`PlanRef`、`TowerRef`、`TokenCountingRef`（`SwarmRef` 已随 2026-09-30 swarm mode 删除移除，status 路由的 `swarm_mode` 字段同删）。
- ErrorCode 面（route/http.ts）：与 kap-server 同义的码同号同名（含 50001 `INTERNAL_ERROR`——kap 对导出失败等内部错误的通用码，sessionExport.ts:192）；本地新增码（kap 无对应语义）全部位于 kap 未占用的号（40421、40931+ facade 缺席族、50002 `REMOTE_CONTROL_FAILED`），无撞号（第 61/62 轮，见「人为设计」错误码号段约定行）。

## 摘要
feature-http 是 harness-core 自有的轻量传输层，与 kap-server 的对应路由在**路由路径、action 后缀协议、请求/响应 JSON 字段（snake_case）、对齐语义的错误码数值**上保持了良好的逐点对齐（sessions/title/export/remote-control/catalog/approvals/questions 的 wire 形状与 v2 schema 逐字段一致，action-suffix 解析器逐字移植）；同时有意做了两个横切分叉——真实 HTTP 状态码取代 v2 的 200-envelope 风格、facade 缺席显式 409xx 取代 DI 恒在。曾有 5 个错误码与 kap-server 撞号：40901/40924/40925/40926 为 kap 无对应语义的新增码，第 61 轮已改号消除；50001 实为同义（kap 对导出失败即返回 INTERNAL_ERROR），第 62 轮撤销改号、改名归位 `INTERNAL_ERROR`（见「人为设计」错误码号段约定行）。最重要的两个差异：① 无鉴权/CORS/安全头（在案，独立议题，且与 remote-control 叠加成安全风险）；② 冷会话不可达 + sessions list 无分页过滤 + prompt 富提交面整体不迁。最需关注的缺口：未捕获错误落 express HTML 500 而非 envelope、undo 消息 created_at 缺省回退到 1970 纪元、v2 的 profile/children/warnings/restore/prompts 列表/skill activate//meta 等路由族尚无覆盖计划（均未在案）。
