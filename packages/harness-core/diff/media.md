# media：harness-core vs agent-core-v2 差异对比

## 对应关系
- harness-core：`packages/harness-core/src/features/media/`（约 1961 行，state/inspect/transform/deliver 四层 + feature/index/read-media.md）
- agent-core-v2：`packages/agent-core-v2/src/agent/media/`（约 2953 行）+ `packages/agent-core-v2/src/agent/tools/read-media-file/`（585 行）；prompt 上传治理另有一半在 `packages/kap-server/src/lib/promptMedia.ts`（567 行）
- 蓝本关系：v2 是直接行为蓝本（本域非 refact-237 第一批 human 蓝本，而是 271 顺序表 #25，第 38 轮按 v2 逐字移植）；共享算法文件（compress/file-type/format-policy/originals/webp）与 v2 几乎逐字一致

## 行为差异

### 人为设计
| 差异点 | v2 行为 | harness-core 行为 | 依据 |
| --- | --- | --- | --- |
| 交付与引用形态 | 工具输出与 prompt 媒体最终以内联 `data:` base64 或 `kimi-file://<fileId>` ref 进入上下文，请求时由 `AgentMediaResolverService`（mediaResolverService.ts:104）物化 | 统一 `media://<ref>` 形态：工具 `store.put` 后输出 `buildMediaRefUrl(ref)` part（deliver/tool.ts:433-438），请求时由 agent-core `useMediaLower`/codec 内 `createMediaLowerer` 物化（agent-core `llm/media/materialize.ts:128`） | 方案一：约束问答（Handoff L77-78）、设计要点（L201）、第 38 轮（L305） |
| kimi-file:// 体系 | 完整闭环：`kimi-file://` URL 语义（mediaRef.ts:102-122）、`SessionMediaStoreService`（sessionMediaStoreService.ts，会话级物化 + 元数据 + 流式 open）、工具 `isDaemonFileUrl` 附件分支（readMediaFileTool.ts:231-233,271-283）、`materializePromptDaemonRefs`（promptMediaIntake.ts）、kap-server 下载路由 | 整体排除：工具只走 `path.resolve(workDir, args.path)`（deliver/tool.ts:269），无附件分支；read-media.md 同步删去 kimi-file:// 段落 | 方案一「kimi-file:// 体系整体排除…留给 kap-server 侧另案」（L78）；设计要点⑧明确不迁（L201） |
| 视频上传时机 | 工具内即上传：`videoUploader` 经 `runWithCredentialRecovery` 调 provider，失败按 `shouldSurfaceVideoUploadError` 上抛或回退 `inlineVideoPart`（readMediaFileTool.ts:208-225,508） | 工具不碰上传：视频与图片一样 `store.put` 成 media:// ref；上传推迟到 codec lower（`materializeLocal` 视频分支：`provider.media.uploadVideo` → cache → `provider.media.inlineVideo` 回退内联 → 占位文本，agent-core materialize.ts:150-173） | 方案一③「视频上传零新增」；第 38 轮偏差③（L305） |
| 工具错误通道 | `{ isError: true, output }` 经 `ExecutableToolResult.isError` 通道传递，模型侧由投影层渲染 `<system>ERROR: Tool execution failed.</system>` 状态块 | 已切回框架通道——错误返回标 `isError: true` 裸 content，`toolOutcomeEntry` 落 history meta，请求装配经 agent-core `renderToolResultForModel` 统一渲染（v2 投影同构，历史保持原始 content）；`tool-error.ts` 已删除 | 用户定稿「A+B 分两步」（L80-81）；B 步落地（L307）；A 步已落地（第 76 轮） |
| 工具成功输出的 note | `note` 是 `ExecutableToolResult` 独立通道（readMediaFileTool.ts:530 `{ output, note, isError: false }`） | note 追加为 `</image>` 之后的末位文本 part（deliver/tool.ts:444-457） | 第 38 轮偏差①（L305，ToolResult 无 note 通道） |
| 工具 description | 按模型能力动态拼接：静态头 + `**Capabilities**` 段（image/video 支持与否四态文案，readMediaFileTool.ts:53-74 + read-media.md:17） | 纯静态 md（features/media/read-media.md，无 Capabilities 段；path 参数描述删 kimi-file:// 句）；能力约束全部 execute 内以 v2 原文案强制（deliver/tool.ts:284-303） | 第 38 轮偏差②（L305）；spec freeze 横切约定（注册时模型配置未定） |
| 工具注册门控 | `registerMediaTools`：无 fs runtime 且无附件存储、或 image_in/video_in 全无 → 不注册工具（registerMediaTools.ts:29-33） | 恒注册；无 host 时执行返回 `READ_MEDIA_HOST_UNAVAILABLE` 文案（deliver/tool.ts:38-39,267）；模型无能力时执行内报错 | host 端口注入约定（未注入即无能力）；设计要点 props 定义（L201） |
| 动态重注册 | `AgentMediaToolsRegistrar` 监听 `AgentStatusUpdated`/runtime 变化，按模型 alias/provider/protocol/能力/runtime 身份组 key 动态注销重注册（mediaToolsRegistrar.ts:71-158） | 不迁：spec freeze，工具集挂载时冻结；能力/模型变化不重建工具 | 设计要点⑧「mediaToolsRegistrar 动态重注册不迁（spec freeze 语义）」（L201） |
| image 配置读取 | `ImageConfigBridge` 监听 config service，把节值推入 image-compress 模块级变量 `setConfiguredMaxImageEdgePx/setConfiguredReadImageByteBudget`（imageConfigBridge.ts:35-39；image-compress.ts:22-49） | `providerRef(ConfigRef)` 可选探测，`limits()` 闭包每次从 image 节现算，缺席回落默认 2000px/256KB（feature.ts:47-51；state/configSection.ts:24-29）；image-compress 内无全局态 | 第 38 轮偏差④「删 v2 全局配置桥」（L305）；config 缺席回落默认值横切约定 |
| 原图持久化目录 | `persistOriginalImage` 缺省落到 `tmpdir()/kimi-code-original-images`，另有 `sessionMediaOriginalsDir(sessionDir)` 助手（image-originals.ts:23-29） | `originalsDir` 为必传 props（transform/originals.ts:17-19），缺省跳过持久化，caption 写「The uncompressed original was not preserved.」 | 设计要点 props「originalsDir? 缺省跳过原图持久化与对应 caption」（L201） |
| 遥测 | `image_compress`/`image_crop`（image-compress.ts reportCompressEvent/reportCropEvent）、`video_upload`（registerMediaTools.ts:58-84）、`media_resolve_fallback`（mediaResolverService.ts 多处） | 全部不迁，compress/crop 无 telemetry 参数 | 设计要点⑧「telemetry…待云端 appender 批次补回」（L201）；遥测不迁横切约定 |
| MCP 媒体输出的共享函数 | v2 MCP output 复用 media 域 `compressImageContentParts`（gate + 压缩 + caption + 原件持久化一体，image-compress.ts:325-386） | `compressImageContentParts` 不迁；harness-core mcp 自行用 `compressImageForModel` + format-policy 助手重组（features/mcp/core/output.ts:11-12,160+） | 第 38 轮偏差④「仅 v2 MCP output 用，#29 时再议」（L305）；第 49 轮 mcp 落地消费 media 能力（L335） |
| 降级回写形态 | 模型不支持/读取失败/上传失败时降级为 `<image path="…">`/`<video path="…">` 路径标签（含 displayPath 解析与 memoized 标签路径刷新，mediaResolverService.ts:419-426,601-615），模型可经 ReadMediaFile 回读 | 不迁：agent-core lower 产出占位文本 `[image omitted: media unavailable]` 等（materialize.ts:32-34,75-79），不含路径 | 设计要点⑧「displayPaths 降级路径回写不迁（agent-core degrade 已是占位文本形态）」（L201） |
| 预算超限警告 | 丢弃时 `WarningIssued{code:'media-budget-exceeded'}` 事件 + 持久化 `media.budgetDropped` agent state（mediaResolverService.ts:59-62,206-218） | 不发事件、无持久 dropped-set；warning 即占位文本本身 | 第 38 轮偏差⑤在案（L305） |
| 目录组织 | 平铺 19 文件 | 数据流向四层：`state/`（configSection）→ `inspect/`（file-type/format-policy）→ `transform/`（compress/originals/webp）→ `deliver/`（tool/intake/budget） | 用户选定维度 A（L309） |
| file-type 归属 | `agent/media/file-type.ts` 从 mediaRef.ts 导入并再导出三张 suffix→mime 表；os 侧另有子集 | 三表并入 `inspect/file-type.ts` 自包含（与 os/file-type.ts 部分重复，去重留后续） | 设计要点④；第 38 轮偏差⑥（L305） |

### 简化 / 保真度损失
| 差异点 | v2 行为 | harness-core 现状 | 影响与后续归属 |
| --- | --- | --- | --- |
| 请求预算计量范围 | resolver 先把 `kimi-file://` ref 物化再按真实字节计预算（daemon ref 与 inline data: 都计），超 20MB 从最旧丢弃至 ≤10MB（mediaResolverService.ts:104-155,172-220） | `createMediaBudgetResolver` 只计 inline `data:` part（deliver/budget.ts:18-56）；media:// ref 在 codec lower 才内联，resolver 时点看不到其字节，同阈值 20MB/10MB | 大图经 ReadMediaFile 进入的历史不计入请求预算，超限只能靠 LLM recovery 兜底；第 38 轮偏差⑤在案（L305），无后续归属记录 |
| 预算丢弃后的模型可回读性 | daemon ref 被丢弃时替换为 `<image path="…">` 路径标签（replaceWithMediaTag），模型可重新 ReadMediaFile | 一律替换为 `[image omitted: dropped to fit the request media budget]` 文本（budget.ts:50-53） | 长会话早期图片被预算丢弃后模型失去回读线索；与 displayPaths 不迁同源（L201 ⑧） |
| 上传缓存粒度 | cache key 含 provider/protocol/baseUrl/账号哈希（Authorization 头或 API key/JWT sub，mediaResolverService.ts:262,539-572），llmFileId 持久化进 IBlobStore 两个 scope，另有 8MB/64MB 内存 image memo 与「provider 不支持上传」记忆 | `MediaUploadCache.get/put(ref, providerKey)`（agent-core cache.ts:3-6），粒度只到 ref+providerKey；视频有 cache，图片 lower 恒内联无上传（materialize.ts:134-143） | 同 provider 多账号切换可能命中错账号的 file id；图片上传通道（v2 `requester.uploadImage`）整体不存在；无记录在案归属 |
| 凭证恢复 | 上传经 `runWithCredentialRecovery`（401/403 触发凭证刷新重试），auth 错误上抛 | lower 仅识别 401/403 上抛，无恢复（materialize.ts:166-168） | 过期凭证下媒体上传直接失败降级；未在案 |
| 工具路径安全 | `resolvePathAccessPath`：敏感文件（env/凭证/SSH）拒绝、工作区外必须绝对路径、`~` 展开、win32 shell 路径桥、additionalDirs（含 skill roots）视为工作区（readMediaFileTool.ts:241-245；path-access.ts:246-303） | 裸 `path.resolve(props.workDir, args.path)`（deliver/tool.ts:269），以上全部缺失 | 模型可让 ReadMediaFile 读 `~/.ssh/id_rsa` 等敏感文件（虽然只会按二进制判型拒绝，但相对路径逃逸工作区无约束）；Handoff 未记录，与 os 域 path-access（features/os/path-access.ts）未打通 |
| 工具审批/规则面 | `ToolAccesses.readFile` + `approvalRule`/`matchesRule` + `display:{file_io}`（readMediaFileTool.ts:246-256） | ToolDefinition 仅 `{name, description, parameters, execute}`；审批由 permission feature 的泛化 `useToolPermission` 统一承载（features/permission/feature.ts:108），工具侧无 per-tool 规则面 | 泛化审批是否等价覆盖取决于 permission 域规则语义；media 自身无 v2 的 literalRulePattern 先例 |
| prompt 格式门控 | loopService 对 prompt/steer 消息四处 `gateImageFormatParts`（不支持的 mime/坏 data URL 替换为 `[Image omitted: …]` 文本，loopService.ts:596,1098,1106,1306） | `gateImageFormatParts` 已移植（transform/compress.ts:210）但 harness-core 内无调用方；prompt gate 只做超预算压缩（deliver/intake.ts） | prompt 里的 heic/avif 等不支持格式原样发给模型，靠 `image_format` LLM recovery 事后 strip；未在案 |
| 工具能力行的模型提示 | description 含「当前模型不支持图片/视频输入」等明示 | 静态描述无此行 | 模型在不支持媒体输入时无 description 级提示，只能执行期报错；第 38 轮偏差②在案 |

### 新增 / 更强
| 差异点 | 说明 |
| --- | --- |
| 无 host 时的显式不可用文案 | v2 在无 fs runtime 时直接不注册工具（模型不知道工具存在）；harness-core 恒注册并返回 `READ_MEDIA_HOST_UNAVAILABLE`（deliver/tool.ts:38-39），模型可感知并换路径（media:// store 分支恒可用） |
| prompt gate 压缩后交付 media:// ref | v2 kap-server prompt 压缩后仍是 base64 inline（promptMedia.ts:236-240）；harness-core intake 压缩后 `store.put` 改写为 media:// ref（deliver/intake.ts:55-81），上下文驻留字节更小，且与 20MB/10MB 预算治理联动（Handoff 第 39 轮评「语义更强」，L318） |
| 幂等 prompt gate | 已 media:// 的 part 与非 data: URL 原样跳过（intake.ts:29-37），重复提交/重放安全 |

## 可配置项差异
| 配置项 | v2 | harness-core | 分类 |
| --- | --- | --- | --- |
| `image.maxEdgePx`（默认 2000） | 同，zod `int().min(1).optional()`（configSection.ts:11-14） | 同（state/configSection.ts:12-15） | 已对齐 |
| `image.readByteBudget`（默认 256KB） | 同 | 同 | 已对齐 |
| env `KIMI_IMAGE_MAX_EDGE_PX` / `KIMI_IMAGE_READ_BYTE_BUDGET` | envBindings + stripEnv（configSection.ts:25-30） | 同名 env + parse + stripEnv（state/configSection.ts:38-51） | 已对齐 |
| 配置生效方式 | ImageConfigBridge 推入模块全局，改配置即全局生效 | `limits()` 闭包现算，config 缺席回落默认 | 人为设计（第 38 轮偏差④） |
| 工厂 props | DI 服务装配（runtime/workspace/capabilities/videoUploader/telemetry/attachmentStore） | `createMedia({ workDir, store, cache, host?, originalsDir? })`，store/cache 必传，host/originalsDir 可选（feature.ts:31-37） | 人为设计（L201）；v2 的 telemetry/attachmentStore 无对应 |
| 上传缓存端口 | IBlobStore 两个 scope + 内存 memo | `MediaUploadCache` 接口（memory/blob 实现由宿主选） | 人为设计（L201，「磁盘会话换 createBlobMediaUploadCache」） |
| 内嵌常量 | MAX_MEDIA 100MB、sniff 512B、decode 64MB、预算 20MB/10MB、memo 8MB/64MB | 前四项逐字对齐（tool.ts:35-36、file-type.ts:1、compress.ts:32、budget.ts:7-8）；memo 无对应 | memo 为简化（见上表）；其余已对齐 |
| inline 视频判定 | 按 protocol：`protocol !== 'openai' && !== 'openai_responses'`（videoUpload.ts:18-20） | 按 provider 端口 flag：`provider.media.inlineVideo === true`（agent-core materialize.ts:170） | 人为设计（agent-core provider-catalog 端口化，能力等价、来源不同） |

## 工具 / 事件 / facade 面差异
- 工具：两侧均仅 `ReadMediaFile`。参数 schema 语义对齐（path/region{x,y,width,height}/full_resolution；v2 用 zod 转 JSON schema，harness-core 手写 JSON schema + 手写 parseArgs 容错，deliver/tool.ts:65-111,210-261），path 描述删去 kimi-file:// 句。输出包裹 `<image|video path="…">…</image>` + `<system>` note 逐字对齐（buildMediaNote 两侧一致）；差异在媒体 part 为 media:// ref（v2 为 data: inline）、错误经框架 isError 通道统一渲染。
- Feature 事件：两侧均无 media 自有 Feature 事件；v2 侧对外信号是 `WarningIssued`（media-budget-exceeded / media-degraded / media-stripped），harness-core 均不发（在案）。
- facade：v2 有 `IAgentMediaResolverService.resolve/displayPaths`、`ISessionMediaStore`、`IAgentMediaToolsRegistrar` 三个 DI 面；harness-core 无 media facade（createMedia 不 useExpose），宿主能力全部经 props 端口注入。

## 摘要
共享算法层（压缩阶梯、判型嗅探、格式策略、原图 LRU、webp wasm）与工具主流程和文案基本逐字对齐，差异集中在交付架构：v2 的「kimi-file:// + DI resolver + 动态重注册」被方案一整体替换为「media:// + props 端口 + spec freeze」，这是本域最大的人为设计分叉。最需关注的缺口有三：① 请求预算只计 inline data:，media:// ref 的真实字节不计量（在案）；② 上传缓存/凭证恢复/图片上传通道等 resolver 深层能力未迁，同 provider 多账号与过期凭证场景保真度下降；③ 工具丢失 v2 的 path-access 防护（敏感文件拒绝、工作区外必须绝对路径），且未在 Handoff 记录。A 步已落地（第 76 轮），tool-error.ts 自渲染已整体拆除，isError 经框架通道统一渲染。
