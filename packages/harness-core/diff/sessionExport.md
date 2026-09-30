# sessionExport：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/sessionExport/`（约 899 行：service 139 / scan 178 / zip ~290 / feature 68 / file-source 75 / manifest 47 / sessionExport 46 / errors 23 / index）+ 对外路由 `src/feature-http/route-features/sessionExport.ts`（`POST /sessions/:session_id/export`）
- agent-core-v2：`packages/agent-core-v2/src/app/sessionExport/`（约 1012 行：sessionExportService 319 / zip ~290 / wire-scan 166 / file-source / manifest / sessionExport / errors）+ 对外路由 `packages/kap-server/src/routes/sessionExport.ts`（197 行）
- 蓝本关系：v2 DI 版为唯一蓝本（271 第 20 轮迁移）。zip.ts / file-source.ts 基本逐字移植（仅 Error2→SessionExportError 与格式化差异）；scan.ts 是按新架构 journal 形态重写的 wire-scan.ts 替代物；service.ts 是 exportSessionDirectory 的收敛重写。

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
|---|---|---|---|
| version 校验时机 | 每次 `export()` 调用校验空白并抛 `SESSION_EXPORT_MISSING_VERSION`（sessionExportService.ts:58-64） | 工厂创建时 fail-fast（feature.ts:28-33），code 与文案逐字保留 | 271 第 20 轮偏差①（记录在案的决定） |
| session 查找通道 | `ISessionIndex.get`（工作区索引），不存在抛 `SESSION_NOT_FOUND` | `useApp().space.get`（SessionSpace catalog），不存在抛 `SessionSpaceError('not-found')`，路由经 sendFacadeErr 映 404 | 新架构 store 体系的自然映射 |
| journal 扫描替代 wire 扫描 | `scanSessionWire` 扫 `<sessionDir>/wire.jsonl` + `agents/**/wire.jsonl`：`record.time` 取活动区间，`turn_begin` 记录取 `lastUserMessageMs` 与 `firstUserInput`（wire-scan.ts） | `scanSessionJournal` 扫 `<sessionDir>/trees/**/*.jsonl`：`kind==='entry'` 的 `ts` 取 min/max，`message.appended` 且 `payload.data.message.message.role==='user'` 取 lastUserMessageMs/firstUserInput（scan.ts；payload 两层 message 嵌套已核实 agentUnit 落盘形态） | 271 第 20 轮主题（「journal 扫描替代 wire.jsonl 扫描」，顺序表 #14 备注） |
| sessionDir 来源 | 由 bootstrap homeDir + workspace persistence scope 推导（`sessionDirOf`） | 工厂 props `sessionDir(sessionId)` 宿主端口；memory-backed 宿主返回 undefined → `session.export_not_found`（文案 "has no exportable directory."） | 271 第 20 轮（宿主端口注入横切约定） |
| 日志路径来源 | global 固定 `resolveGlobalLogPath(homeDir)`、desktop 固定 `<home>/logs/kimi-code-desktop.log` | 工厂 props `globalLogPath?` / `desktopLogPath?` 注入 | 宿主端口注入横切约定 |
| 错误体系 | `Error2` 域注册（4 码）+ 通用 `FS_IS_DIRECTORY` 兼作 not-a-file | `SessionExportError extends Error { code }`，5 码——前 4 码与 v2 逐字一致 + `session.export_not_a_file` 替代 FS_IS_DIRECTORY | 271 第 20 轮偏差⑤（Error2 域注册机制不迁，coded error 统一范式） |
| 路由落点 | kap-server 独立路由文件（defineRoute + schema 校验） | feature-http `route-features/sessionExport.ts`，facade 经 `inject(SessionExportRef)` 可选解析 | 271 第 20 轮偏差⑦（AppCommands 无 resolve，app 层 token 经 inject 祖先链解析，本轮首例） |
| 测试规模 | v2 侧 20 案 | 收敛为 9 案——轮转/fd 耗尽/符号链接调换/追加中压缩等 zip 内部韧性案未移植（机制逐字保留，蓝本测试仍在 v2 侧覆盖） | 271 第 20 轮偏差⑥ + 约束问答测试策略（精简行为测试非全量移植） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
|---|---|---|---|
| **live flush 不迁** | 导出前对 live session 做三段 flush：session metadata（刷新 title）→ session log flush → 逐 agent `IWireService.flush()`；global log flush 带一次重试（`flushLiveSession`/`warnIfFails`，sessionExportService.ts:75-141） | 整段删除——NodeBackend appendFile 逐条 await 落盘、无缓冲写入器与 log 服务；当前语义为「导出磁盘上已有的 session 目录」；title 取 catalog `record.title` | 271 第 20 轮偏差②（记录在案）；live 会话导出内容的及时性依赖 journal 已落盘进度 |
| **session log 防轮转捆绑不迁** | `<sessionDir>/logs/kimi-code.log` 单独 open 为稳定 ZipSource、从递归文件列表剔除后按稳定源重新插入排序（防收集期间日志轮转读到半个文件，sessionExportService.ts:179-215） | 无对应物（新架构无 `logs/kimi-code.log` 生产者）；通用 ZipSource 机制保留给 global/desktop log | 271 第 20 轮偏差③（记录在案） |
| **manifest 两字段恒 undefined** | `workspaceDir`（workspace.root）、`sessionLogPath`（捆绑成功时 `logs/kimi-code.log`） | 恒 undefined（manifest.ts:38-39；类型保留）；`wireProtocolVersion` 从 v2 的 `WIRE_PROTOCOL_VERSION` 常量必填改为 props 可选（example 未传 → manifest 该字段缺失） | 271 第 20 轮偏差④（记录在案）；导出包的自描述性下降 |
| 路由中止/清理细节 | kap-server 路由：response close → `exportAbort.abort()` 传入 export signal + 销毁流；cleanup `rm` 带 `maxRetries:3, retryDelay:50` 并 warn 日志；aborted 多检查点（sessionExport.ts:63-167） | 简化等价：不传 signal（客户端断连不中止导出）、流 close 即 `rm` 临时目录（无重试无日志） | 271 第 20 轮「遗留」（记录在案的简化） |
| 路由 desktopVersion | desktop=true 时传 `hostIdentity.version` 进 manifest | 路由不传（facade `ExportSessionInput.desktopVersion` 存在但 HTTP 面没有对应入参） | manifest.desktopVersion 经 HTTP 恒缺失；facade 直接调用仍可传 |
| firstUserInput 语义 | `turn_begin.userInput`（真实用户 prompt 文本） | 首个 `role==='user'` 的 message.appended 文本拼接——user 角色的 drained reminder（source 'reminder'）也满足条件 | 极端排序下可能取到注入提醒而非真实首问（调试清单字段，影响轻微） |

### 新增 / 更强
| 差异点 | 说明 |
|---|---|
| 路由错误码细分 | v2 kap-server 对非 not-found 一律 INTERNAL_ERROR 50001；feature-http 新增 `ErrorCode.SESSION_EXPORT_UNAVAILABLE 40936`（facade 未挂载 409），导出失败返回 `INTERNAL_ERROR 50001`（SessionExportError 500，与 v2 同码同义），`SessionSpaceError` 经 sendFacadeErr 404——调用方可区分「未安装/不存在/失败」三态 |
| 工厂 fail-fast | version 空白在挂载期即抛错（v2 要等到首次导出），宿主配置错误前置暴露 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
|---|---|---|---|
| version | 每次调用 `ExportSessionPayload.version`（kap-server 传 hostIdentity.version） | 工厂 props `version` 必填（空白挂载期抛错） | 人为设计（第 20 轮偏差①） |
| sessionDir | 内部按 homeDir/scope 推导 | 工厂 props `sessionDir(sessionId): string \| undefined` 必传 | 人为设计（宿主端口） |
| globalLogPath / desktopLogPath | 内部按 homeDir 推导 | 工厂 props 可选 | 人为设计（宿主端口） |
| wireProtocolVersion | `WIRE_PROTOCOL_VERSION` 常量必填 | 工厂 props 可选（缺省 manifest 无此字段） | 简化（第 20 轮偏差④） |
| includeGlobalLog / includeDesktopLog / webLog / outputPath / signal / desktopVersion / installSource / shellEnv | `ExportSessionPayload` + `ExportSessionOptions` 逐次传入 | `ExportSessionInput` 同名字段全保留 | 已对齐 |
| config 节 / env 绑定 | 无 | 无 | 已对齐 |
| 默认启用 | DI App 级 `registerScopedService(OnScopeCreated)` 恒在 | app tier 工厂不进 preset，宿主显式挂载（example 已挂） | 人为设计（工厂形态横切约定） |

## 工具 / 事件 / facade 面差异
- 无 agent 工具、无 Feature 事件（两侧一致）。
- facade：v2 `ISessionExportService.export(payload, options?)`（DI 服务，payload 含 version）；harness-core `SessionExportRef.export(input): Promise<ExportSessionResult>`（app 层 `useExpose`；`ExportSessionResult { zipPath, entries, sessionDir, manifest }` 形状一致；`ExportSessionManifest` 字段集一致，仅 wireProtocolVersion 变可选、workspaceDir/sessionLogPath 恒 undefined）。
- HTTP 面：`POST /api/v1/sessions/{session_id}/export`（body `{desktop?, web_log?}`，两側字段名一致）；成功均为流式 `application/zip` + `content-disposition: attachment; filename="kimi-session-<safe>.zip"` + content-length + no-store；`sanitizeSessionId` 逐字一致；默认导出文件名 `kimi-debug-<id前8>-<yyyyMMdd-HHmmss>.zip` 逐字一致；file-history blob 段（`file-history` 路径组件）排除逻辑一致。

## 摘要
总体对齐程度高：zip 机制（yazl 懒源、原子落盘、输出冲突 dev/ino 检测、abort 接线、source 所有权转移）逐字保留，manifest 字段集、对外 HTTP 契约、文件名与错误码词表基本同构。最重要的三个差异：① live flush 整段不迁，导出语义退化为「磁盘上已有的 session 目录」（第 20 轮记录在案）；② journal 扫描替代 wire.jsonl 扫描是本轮的刻意设计，但 manifest 的 workspaceDir/sessionLogPath 恒空、wireProtocolVersion 变可选，导出包自描述性下降；③ 路由层中止/清理细节简化为「流 close 即清理」，客户端断连不再中止导出。最需关注的缺口：wireProtocolVersion 缺省缺失对下游解包工具的潜在影响，以及 live 会话导出及时性依赖 journal 落盘进度的语义变化是否需要在文档中明示。
