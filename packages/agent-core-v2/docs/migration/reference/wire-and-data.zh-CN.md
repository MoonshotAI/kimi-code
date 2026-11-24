# wire 与磁盘数据:journal、迁移链、修复与 `~/.kimi-code` 布局

日期:2026-09-19。代码基线:`ccf3d5d6`(main 上删除 v1 的 #3542 的直接父提交)。此时 v1 `@moonshot-ai/agent-core` 0.15.8 与 v2 `@moonshot-ai/agent-core-v2` 0.4.3 并存;本文所有路径与符号均以该基线逐条核对。文中路径一律从仓库根写起。本文是 [`migration-from-v1.zh-CN.md`](../../migration-from-v1.zh-CN.md) 的子文档;英文原版:[`wire-and-data.md`](wire-and-data.md)。

## 0. 两侧 wire 实现对照总表

| 关切 | v1(`packages/agent-core`,0.15.8) | v2(`packages/agent-core-v2`,0.4.3) |
|---|---|---|
| 协议版本常量 | `AGENT_WIRE_PROTOCOL_VERSION = '1.4'`,`src/agent/records/migration/index.ts:11` | `WIRE_PROTOCOL_VERSION = '1.5'`,`packages/agent-core-v2/src/wire/migration/migration.ts:19` |
| 迁移链 | `src/agent/records/migration/{v1.1,v1.2,v1.3,v1.4}.ts`(链到 1.4) | `src/wire/migration/{v1.1,v1.2,v1.3,v1.4,v1.5}.ts`(链到 1.5) |
| 读取/恢复入口 | `AgentRecords.replay()`,`src/agent/records/index.ts:283` | `WireService.readJournal()`,`src/wire/wireService.ts:105` |
| 写路径 | `FileSystemAgentRecordPersistence`,`src/agent/records/persistence.ts:48` | `AppendLogStore`(node-fs),`src/persistence/backends/node-fs/appendLogStore.ts:38` |
| 记录形状 | `AgentRecord`,`src/agent/records/types.ts` | `WireRecord`(`{type,time?,[key]}`),`src/wire/record.ts:17` |
| journal 文件名 | `wire.jsonl`(agent homedir 下) | `wire.jsonl`,常量 `AGENT_WIRE_RECORD_KEY`,`src/wire/record.ts:3` |

v1 与 v2 的 v1.0→v1.4 四步迁移**逐字节同逻辑**(仅注释与 import 路径差异,`diff` 验证);v2 多出 v1.4→v1.5 一步。v1 的 `v1.3.ts` 文件头注释明确 v1.2→v1.3 是"bump-only"(blobref 引入,无需变换)。

## 1. v2 迁移链:每步形状变化、触发、版本判定、失败行为

### 1.1 各步形状变化(`packages/agent-core-v2/src/wire/migration/`)

| 步 | 文件:符号 | 形状变化 |
|---|---|---|
| 1.0→1.1 | `v1.1.ts:31` `migrateV1_0ToV1_1` | 只动 `context.append_message`:`message.toolCalls[]` 从 OpenAI 嵌套形 `{type:'function',id,function:{name?,arguments?}}` 拍平为 `{type,id,name,arguments}`(其余字段展开保留,`v1.1.ts:22-29`)。其他记录原样 |
| 1.1→1.2 | `v1.2.ts:33` `migrateV1_1ToV1_2` | 只动 `permission.record_approval_result` 且 `result.decision==='approved'`、`result.scope==='session'`、尚无 `sessionApprovalRule` 的记录:按 `LEGACY_SESSION_APPROVAL_ACTION_TO_PATTERN`(v1.2.ts:20-26,`'run command'→'Bash'`、`'edit file'/'write file'/'edit file outside of working directory'→'Write'`、`'stop background task'→'TaskStop'`)回填 `sessionApprovalRule`;action 不在表内则回退 `toolName`;`'run command in plan mode'`/`'run background command'` 属 `LEGACY_SESSION_APPROVAL_UNRESTORABLE_ACTIONS`(v1.2.ts:28-31),不回填 |
| 1.2→1.3 | `v1.3.ts:3` | 恒等(bump-only;blobref 由读写层透明处理) |
| 1.3→1.4 | `v1.4.ts:46` `migrateV1_3ToV1_4` | 目标域(goal)多目标→单目标:`goal.create` 保留 `goalId/objective/completionCriterion/time`;`goal.update` **丢弃 `goalId`**,只留 `status/reason/turnsUsed/tokensUsed/wallClockMs/actor/time`;`goal.account_usage`→改写为 `goal.update{tokensUsed,wallClockMs,time}`;`goal.continuation`→`goal.update{turnsUsed,time}`;`goal.clear` 丢弃 `goalId` 只留 `time`(v1.4.ts:67-112) |
| 1.4→1.5 | `v1.5.ts:3` `migrateV1_4ToV1_5` | 对"推进活动区间"的 goal 记录(`goal.create`,或 `goal.update` 且 `status==='active'` 或 `status===undefined && typeof wallClockMs==='number'`,`v1.5.ts:14-21`)且尚无 `wallClockResumedAt` 且 `time` 为 number:补 `wallClockResumedAt = time` |

链注册:`migration.ts:29-35` `MIGRATIONS`;版本比较:`compareWireVersions`(`migration.ts:96-107`,点分数字逐段比)。

### 1.2 触发点(读路径)

迁移只在 `WireService.readJournal()`(`wireService.ts:105-191`)内发生,调用方两处:

- 冷恢复:`EventDispatcherService.restore()`(`src/state/eventDispatcherService.ts:776-827`)逐条 `readJournal()`,跳过 `metadata`,按 `folded.events` 注册表把记录转回事件 `executeEvent(event, true)`;由 `AgentLifecycleService.doCreate` 的 `stage='restore'` 触发(`src/session/agentLifecycle/agentLifecycleService.ts:209-210`,在其前的 `stage='seal'` 调 `IWireService.seal()`,`:194`)。
- 晚绑定 durable participant:`EventDispatcherService.attachLate()`(`eventDispatcherService.ts:266-315`)同样全量 fold 一遍。

注意:**fork 路径不跑迁移**——`SessionLifecycleService.readSourceWireRecords`(`src/workspace/sessionLifecycle/sessionLifecycleService.ts:764-801`)用 `appendLogStore.read` 原样收集记录(只做截断修复),`rewrite` 进目标 journal(`:761`),迁移延迟到 fork 后 agent 首次 restore。

### 1.3 版本判定(`readJournal` 首个有效记录分支,`wireService.ts:130-148`)

- 第一个通过 `isWireRecord`(`record.ts:29`)的记录决定全程迁移集 `migrations`:
  - `type !== 'metadata'`(无元数据的古老 journal)→ 视为 1.4:**只应用 `migrateV1_4ToV1_5`**,并预设 `rewrittenRecords=[createWireMetadataRecord()]`(`:132-134`);
  - `type==='metadata'` 但字段不全(`isWireMetadataRecord` 失败,`record.ts:46`)→ 抛 `StorageError(STORAGE_CORRUPTED,'Agent wire metadata is malformed')`(`:135-140`),读路径硬失败;
  - `isNewerWireVersion(protocol_version)`(比 1.5 新)→ `newerWireVersion=true`:**不迁移、不做 plan 规整、不重写**,记录原样透传 yield(`:141-143, 151-166`);**注意:不是拒读**——主文档 `packages/agent-core-v2/docs/migration-from-v1.zh-CN.md:38` 早期版本的"读到比当前新的版本则拒读"与代码不符,主文档已于 2026-09-19 更正为透传(本文按代码事实写)。v1 侧对称行为是 warning 后照样 replay(`src/agent/records/index.ts:302-304`);
  - 否则 `resolveWireMigrations(protocol_version)`(`migration.ts:41-62`),若版本≠1.5 则 `rewrittenRecords=[]` 准备重写。
- 每条记录 `migrateWireRecord` 顺序 fold 全链;非 newer 时 `metadata` 记录的 `protocol_version` 被改写为当前版本(`:151-155`)。
- 未知 sourceVersion(链中无起点)→ `WireError(WIRE_MIGRATION_MISSING)`(`migration.ts:50-56`,`errors.ts` code `wire.migration_missing`,action 文案 "start a new session"),从 `readJournal` 抛出 → `restore()` 失败 → agent create 在 `stage='restore'` 失败(`agentLifecycleService.ts:216-219` 记 `agent_create_failed` telemetry 后向上抛)。

### 1.4 读路径的其他规整与失败行为

- 非 wire 形状的行(无 `type:string`)→ `reportSkippedRecord`(`wireService.ts:124-127, 330-342`):只上报 `onUnexpectedError(WireError WIRE_UNKNOWN_RECORD)`,跳过继续。
- `plan.revision` 旧形状规整(`normalizePlanRevisionRecord`,`:297-328`):`key` 缺失但有 `path` 的记录,`extractLegacyPlanRevisionKey`(`:360-374`)把 `sessions/<ws>/<sid>/agents/<agentId>/plan/<id>/v<N>.md` 形式的绝对/相对 path 折成作用域内 key `plan/<id>/v<N>.md`(含 `\`、段数不足、agentId 不匹配、正则不满足 → 丢记录并 telemetry `wire_plan_revision_migrated` outcome `skipped`)。若发生过此类规整而 `rewrittenRecords` 原本 undefined,读完后 `rebuildRewriteRecords`(`:272-295`)重读全量重建再重写。
- 读完后的落盘(`:178-190`):有截断 → `repairJournal`;否则 `rewrittenRecords !== undefined`(版本迁移/补 metadata/空 journal)→ `log.rewrite` 原子重写整本 journal,并重置 `lines`/`lastClearLine`;空 journal(0 记录)→ 重写为仅含新 metadata 一行。
- `seal()`(`:64-71`):journal 为空则 append 一条当前版本 metadata;每个 agent create 都会走(幂等)。

## 2. `wire/repair.ts`:触发条件与行为

### 2.1 触发条件

底层信号来自 `AppendLogStore.read` 的行解析(`persistence/backends/node-fs/appendLogStore.ts:58-94`):

- 中途某行 `JSON.parse` 失败 → `onTruncate({lineNumber, reason:'corrupted', cause})` 并**停止读取**;无 `onTruncate` 回调则抛 `AppendLogCorruptedError`(`interface/appendLogStore.ts:7-19`,code `storage.corrupted`)。
- 文件末尾存在非空、无法解析的残行(无 `\n` 结尾的尾巴)→ 视为崩溃半写,`onTruncate({lineNumber, reason:'truncated'})`(`appendLogStore.ts:84-93`);末行可解析则正常 yield。
- `AppendLogTruncation` 类型:`interface/appendLogStore.ts:25-29`。

两个触发点:

1. resume/读路径:`WireService.readJournal` 收集到 truncation 后调 `repairJournal`(`wireService.ts:184-185, 205-237`)。
2. fork 路径:`readSourceWireRecords` 发现 truncation 直接修**源** journal(`sessionLifecycleService.ts:786-799`)。

### 2.2 行为(`repair.ts:20-64` `repairWireJournal`)

1. `storage.read(scope,key)` 读原始字节;`countJournalLines` 按 `0x0A` 计行,`droppedCount = max(0, 原行数 - 有效记录数)`(`:66-78`)。
2. 备份:若 `wire.jsonl.bak`(`wireJournalBackupKey`,`repair.ts:16-18`)不存在 → 把原始字节**原子写**到同 scope 的 `.bak`(已存在则不覆盖,`:37-40`)。
3. `appendLog.rewrite(scope,key,records)` 把有效前缀原子重写回 journal(`:42`;rewrite 底层是 `storage.write(..., {atomic:true})`,`appendLogStore.ts:113-133`)。
4. 任何异常 → `outcome='failed'`,但**不抛出**;`log.warn('corrupted wire journal truncated to its valid prefix', ...)` + telemetry `track2('wire_repair', {kind: truncation.reason, outcome, dropped_count, backup_created})`(`:47-62`)。返回 `'repaired'|'failed'`。

### 2.3 失败后的悬挂修复(仅 wireService 路径)

`repairJournal` 把失败存入 `pendingRepair`(`wireService.ts:232`);此后每次 `appendRecord` 走队列时先 `repairPendingJournal()` 重试(`:90-98, 239-258`),重试仍失败则置 `persistError = WireError(RECORDS_WRITE_FAILED)` 并抛出,本次 append 不落盘;`flush()`(`:264-270`)会把挂起的 `persistError` 重新抛出(一次性)。修复成功则重置 `lines`/`lastClearLine`(`:233-236`)。

对照 v1:v1 无 repair;`FileSystemAgentRecordPersistence` 中途损坏直接 throw(`persistence.ts:210-217`),截断尾行静默容忍(`:201-219`),resume 即失败。

## 3. v2 persistence 与 `~/.kimi-code` 磁盘布局(对照 v1)

### 3.1 根与 scope 解析链

- homeDir:`resolveKimiHome` = `homeDir ?? KIMI_CODE_HOME ?? <osHome>/.kimi-code`(`src/app/bootstrap/bootstrap.ts:163-169`);`FileStorageService` 以 homeDir 为 baseDir,dirMode `0o700` / fileMode `0o600`(`bootstrap.ts:146-152` 的 `storageSeed`);`pathFor(scope,key)=join(baseDir,scope,key)`(`fileStorageService.ts:252-254`)。
- scope 链(全部相对 homeDir 的 POSIX 风格相对路径):
  - workspace:`persistenceScope = sessions/<workspaceId>`(`src/workspace/workspaceInstance/workspaceInstanceManagerService.ts:201`;`bootstrap.scope('sessions')='sessions'`,`bootstrapService.ts:45-59`)。`workspaceId = encodeWorkDirKey(root)` = `wd_<slug>_<sha256(root)[:12]>`(`src/_base/utils/workdir-slug.ts:17-23`)。
  - session:`sessionScopeOf = sessions/<wd>/<sessionId>`(`src/workspace/sessionLifecycle/internal/addressing.ts:7-9`);`sessionDir = <homeDir>/sessions/<wd>/<sid>`(`addressing.ts:11-13`,`sessionLifecycleService.ts:243-244`)。
  - agent:`agentScopeOf = <sessionScope>/agents/<agentId>`(`addressing.ts:15-17`;`agentLifecycleService.ts:131`)。

### 3.2 布局表(v2,`<homeDir>` = `~/.kimi-code`)

| 路径 | 内容 | 写入方(符号) |
|---|---|---|
| `session_index.jsonl` | 全局 session 索引,append-only,行 `{sessionId,sessionDir,workDir}`;scope `''` | `SessionLifecycleService.appendSessionIndexEntry`(`sessionLifecycleService.ts:323-331`,经 `IAppendLogStore`);`SESSION_INDEX_KEY`,`src/app/workspace/workspaceAlias.ts:8-9` |
| `workspaces.json` | workspace 目录 `{version:1,workspaces,deleted_workspace_ids}` | `FileWorkspacePersistence`(`src/app/workspace/fileWorkspacePersistence.ts:16-18, 84`),经 `IAtomicDocumentStore`(JSON 原子写,`persistence/backends/node-fs/atomicDocumentStore.ts:86-90`) |
| `sessions/<wd>/<sid>/state.json` | session 元数据(`SESSION_META_VERSION = 2`) | `SessionMetadata`(`src/session/sessionMetadata/sessionMetadataService.ts:23, 99`;scope = `ctx.metaScope` = sessionScope,`sessionLifecycleService.ts:245`) |
| `sessions/<wd>/<sid>/session-meta/state.json` | 旧 v2 布局的 meta,只作兼容读;读到后归档操作会迁回上者并删旧文件 | `legacySessionMetaScopeOf`(`addressing.ts:19-21`);`coldSessionArchive.ts:33-44`;`sessionIndexSource.ts:122-124` 同样双位置兜底 |
| `sessions/<wd>/<sid>/agents/<aid>/wire.jsonl` | **agent journal** | `WireService`(`AGENT_WIRE_RECORD_KEY`);`journalPath()` 暴露实际路径(`wireService.ts:201-203`) |
| `sessions/<wd>/<sid>/agents/<aid>/wire.jsonl.bak` | 修复前原文备份(只建一次) | `repairWireJournal` |
| `sessions/<wd>/<sid>/agents/<aid>/blobs/<sha256>` | 媒体 blob;key = base64 payload 字符串的 sha256 hex;>4096B 的 `data:` URI 才 offload | `AgentBlobServiceImpl`(`src/agent/blob/agentBlobServiceImpl.ts:28, 115-134`;scope `agentCtx.scope('blobs')`);记录内 URL 改写为 `blobref:<mime>;<hash>`(`BLOBREF_PROTOCOL`,`agentBlobService.ts:5`) |
| `sessions/<wd>/<sid>/agents/<aid>/plan/<id>/v<N>.md` | 计划不可变修订版 | `planService.ts:206-207`(配合 `plan.revision` 记录的 `key`) |
| `sessions/<wd>/<sid>/agents/<aid>/plans/<id>.md` | 当前计划文件 | `planService.ts:239` |
| `sessions/<wd>/<sid>/agents/<aid>/tool-results/…` | 超限工具结果外置 | `toolResultTruncationService.ts:43`(scope `tool-results`) |
| `sessions/<wd>/<sid>/agents/<aid>/file-history/<hash>@v<N>` | 文件历史 blob | `fileHistory.ts:60` `FILE_HISTORY_BLOB_PREFIX='file-history'`;`fileHistoryService.ts:417-423, 556` |
| `sessions/<wd>/<sid>/tool-policy/…` | session 工具策略 | `sessionToolPolicyService.ts:43` |
| `sessions/<wd>/<sid>/media/…` | session 媒体附件 | `sessionMediaStoreService.ts:38` |
| `cache/query-store/` | **minidb 结构化读模型**(ClusterDb,16 分片,json codec,`fsyncPolicy:'everysec'`,valueMode memory) | `MiniDbQueryStore`(`src/persistence/backends/minidb/miniDbQueryStore.ts:26-29, 64, 84-94`);session 索引 collection `session:g<N>` / `sessionCounters:g<N>`、checkpoint `__checkpoint__`、manifest `'sessionIndex'`(`src/app/sessionIndex/sessionIndexModel.ts:3-22`) |
| `search-index/` | 全局全文搜索 minidb(kap-server;独立库) | `searchService.ts:56, 254`(homeDir + `search-index`) |
| `credentials/mcp/…` | MCP OAuth 凭据 | `mcpConfig/oauthStore.ts:15` |
| `logs/kimi-code.log`、`cache/`、`store/`、`blobs/`(home 级) | 日志等;`storeDir`/`blobsDir` 在 `IBootstrapService` 声明并经 klient env 契约暴露,但 agent-core-v2 src 内无写者(仅 `cacheDir` 被 query-store 使用) | `bootstrapService.ts:45-49`;`klient/src/contract/global/env.ts:34-37` |

写原语:`FileStorageService`(`fileStorageService.ts`)——`write`/`writeStream` 走 `atomicWrite`(tmp+rename)+ 目录 fsync 一次(`syncDirOnce`,`:260-268`);`append` 开 `'a'` 句柄写后 `fh.sync()`(`durable` 默认 true,`:114-140`);`read` 有 torn-read 重试(3×15ms,`:20-21, 38-58`);`watch` 基于 chokidar 150ms 去抖(`:183-245`)。`AppendLogStore` 在其上做 microtask 批写、`onDidWrite` 事件、refCount 退休(`acquire`/`drainRetirements`)。

### 3.3 session 索引的双层结构(v2 特有)

- **权威源** = `session_index.jsonl` + 每个 session 的 `state.json`(扇出扫描,`sessionIndexSource.ts:93-154`;并发 16)。
- **派生读模型** = minidb。`FileSessionIndex`(`sessionIndexService.ts:74`)由 flag `persistence_minidb_readmodel`(env `KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL`,**默认开**,`persistence/backends/minidb/flag.ts:3-11`)门控。`SessionIndexProjector.project(generation)` 全量重建换 generation(`sessionIndexProjector.ts:94-152`,旧 generation 异步 drop);`prepare` 以 `sourceMaxMtimeMs` 做 freshness 判断(`sessionIndexService.ts:162-173`);ready 后 60s reconcile(`RECONCILE_INTERVAL_MS`,`:52`);degraded 时 5s 重试并**回落到权威源直读**(`withReadModel`,`:322-355`);minidb 损坏(SyntaxError/CorruptFrameError)整库 `rm -rf` 重建(`miniDbQueryStore.ts:41-43, 96-112`)。写侧另有 `SessionIndexMirror` 100ms/500 条批量把 live 变更刷入读模型(`sessionIndexMirrorService.ts:20-79`)。

### 3.4 与 v1 布局的差异

| 项 | v1 | v2 | 差异 |
|---|---|---|---|
| home | `~/.kimi-code`(KIMI_CODE_HOME) | 同 | 无 |
| 全局 session 索引 | `<home>/session_index.jsonl`,同 line 形状,另有 tombstone `{sessionId,deleted:true}` 行(`src/agent-core/src/session/store/session-index.ts:13-16, 39-44`) | 同路径同行形;**v2 不写 deletion tombstone**(删除走读模型 evict/目录移除);v2 `parseSessionIndexLine` 不识别 `deleted` 字段(`workspaceAlias.ts:85-105`) | 读兼容(v2 跳过无法解析行);删除语义不同 |
| workspace 目录 | `<home>/workspaces.json`,`{version:1,workspaces,deleted_workspace_ids}`(`src/agent-core/src/session/store/workspace-registry-file.ts:10-38`,注释明示"v1-compatible,v2 读写同一文件") | 同文件同形状(`fileWorkspacePersistence.ts:16-18, 69-86`) | 无(共享契约) |
| workspaceId/bucket | `wd_<slug>_<sha256[:12]>`,hash 输入是 `normalizeWorkDir(workDir)`(resolve 后)(`src/agent-core/src/session/store/workdir-key.ts:10-22`);另有 `resolveWorkspaceId` 注册表钩子优先(`session-store.ts:92-102`) | `wd_<slug>_<sha256[:12]>`,hash 输入只做 `\`→`/` 与去尾斜杠,**不 resolve**(`_base/utils/workdir-slug.ts:17-23`);别名归并由 `collectAliasIds`/`dedupeByRoot`(`workspaceAlias.ts:19-56`)+ `workspaceRootKey`(Windows 形大小写折叠) | 对已规范化绝对路径结果一致;相对/未规范化入参会得到不同 bucket(**待核**:kap-server 各 `createOrTouch` 调用点入参是否恒为规范化绝对路径,未逐一追踪,如 `kap-server/src/routes/sessions.ts:240`) |
| session 目录 | `<home>/sessions/<wd>/<sid>/`,`state.json` 在目录根部(`session-store.ts:81, 201`) | 同 | 无(v2 另兼容读旧 v2 的 `session-meta/state.json`,见 3.2) |
| wire journal | `<sessionDir>/agents/<aid>/wire.jsonl`(`session-store.ts:588`;`agent/index.ts:224`) | 同路径 | 无 |
| blob | `<agentHomedir>/blobs/<sha256>`(`agent/index.ts:217-219`;阈值 4096、同 blobref 协议,`records/blobref.ts:7-11`) | 同路径、同阈值、同 hash 输入(base64 字符串)(v2 `agentBlobServiceImpl.ts:14, 128-134`) | 无 |
| 结构化索引/搜索 | 无 minidb;列表直接扫 `session_index.jsonl`+`state.json`(`session-store.ts:430-441`) | minidb 读模型(`cache/query-store`)+ kap-server 全文库(`search-index/`) | v2 新增,可删重建 |
| 协议版本 | 1.4 | 1.5 | v2 链为 v1 超集(多 1.4→1.5) |

## 4. node-sdk `src/v2/resume-replay.ts` 的 v1 依赖点

### 4.1 它做什么

`foldAgentWireReplay(wirePath)`(`packages/node-sdk/src/v2/resume-replay.ts:104-121`):readFile 读 v2 的 `<sessionDir>/agents/<aid>/wire.jsonl` → `parseWireRecords`(`:128-142`,复刻 v1 行规则:空行跳过、末行截断容忍、中途损坏抛错)→ 喂给一个 **throwaway v1 `Agent`**(内存只读 persistence,`ReadOnlyAgentRecordPersistence`,`:81-97`)→ `agent.resume({rewriteMigratedRecords:false})` → 取 `agent.replayBuilder.buildResult()` 与 `agent.tools.storeData()` 作为 v1 契约 `ResumedAgentState.replay` / `toolStore`。一切异常 → `EMPTY_FOLD`(`:71, 118-120`)。唯一调用点:`sdk-rpc-client-v2.ts:1166`(`resumedAgentState`),`:1188, 1197` 消费结果;replay 再经 v1 的 `limitAgentReplayByTurns`(`src/agent-core/src/agent/replay/turns.ts:56`)截断。

### 4.2 具体依赖的 v1 符号与语义(为什么"必须用 v1 fold")

- 导入(`resume-replay.ts:58-63`):`Agent`、`type AgentRecord`、`type AgentRecordPersistence`、`type AgentReplayRecord`,全部来自 `@moonshot-ai/agent-core` 包根(node-sdk `package.json:62` 在 `devDependencies` 块中,以 `"@moonshot-ai/agent-core": "workspace:^"` 声明为开发依赖)。
- 依赖的行为(文件头注释 `:1-54` 自述,代码均可核):
  - `AgentRecords.replay` 的 restore 大 switch(`src/agent-core/src/agent/records/index.ts:32-178`):每种记录类型调到对应子域的 restore 方法(`context.appendMessage`、`permission.setMode`、`goal.restoreCreate/Update/Clear` 等)——这是 fold 的全部语义。
  - 版本处理:v2 journal 是 1.5,v1 只认到 1.4 → `isNewerWireVersion` 分支仅 warning、原样 replay(`records/index.ts:302-304`);v1.5 新增的 `wallClockResumedAt` 对 v1 是透传未知字段(v1 `GoalState` 本就有此字段,`src/agent-core/src/agent/goal/index.ts:291`,兼容)。
  - `ContextMemory.finishResume()` / `TurnFlow.finishResume()`(`agent/index.ts:542-543`):resume 末尾合成中断 tool-result 记录——在 fold 里这些 append 落进内存 buffer,不碰磁盘(`resume-replay.ts:48-53, 73-80`)。
  - `ReplayBuilder`(`agent/index.ts:165, 250`;`finishRestoringRecord` 决定 replay 记录产出)与 `ToolManager.storeData()`。
  - 注释明示不重新实现的理由(`:11-18`):assistant 消息从 loop event 组装的微妙语义(`step.begin` 开消息、`content.part`/`tool.call` 原地改、`tool.result` 收尾、缺口补 interrupted result、defer flush)、`context.undo`、`context.apply_compaction` patch —— 重新实现会 drift。
  - 记录类型→replay 映射表写在 `:20-46`(可直接摘入 Reference):含 `profile.bind` 在 v1 restore 里映射回 `config.update`+`tools.set_active_tools` 但不产 `config_updated` replay 记录(`records/index.ts:51-72`);`tools.update_store` 不产 replay 记录、last-wins 进 toolStore;v2-only 记录(`plan.revision`、`task.*`、`skill.activate`、`interaction.*`、`token_counting.*`、`llm.*`)落到 v1 switch 之外被忽略。

### 4.3 v1 删除后的断点与 `packages/transcript` 可提供的替代

断点:整个文件失去编译依赖(`Agent`/restore switch/ReplayBuilder/ToolManager.storeData 只在 v1 存在);`sdk-rpc-client-v2.ts` 还有额外的 v1 import(`:140-152` 的 `limitAgentReplayByTurns`、`KimiError`、`ensureConfigFile` 等),但 fold 是其中唯一**行为性**依赖。主文档已将其列为待清债(`docs/migration-from-v1.zh-CN.md:130, 237`)。

`@moonshot-ai/transcript`(packages/transcript;纯 TS、无引擎依赖,node-sdk 目前**无**此依赖,`package.json` 无条目)现有的 wire→渲染模型 fold:

- `foldWireRecordFacts(records: Iterable<HistoryWireRecord>, base: AgentTranscriptSnapshot, options?)`(`src/history/foldFacts.ts:222-226`):wire 记录 → transcript 事实层(items/markers/taskrefs、tasks、interactions、todo、goal、plan/swarm/tower mode、undo anchor);`HistoryWireRecord` 结构上与 v2 `WireRecord` 同形(`foldFacts.ts:9-13`)。
- `groupMessagesIntoSnapshot(messages, options?)`(`src/history/groupTurns.ts:69-75`):`context.append_message` 消息列 → turn/step/frame 结构的 `AgentTranscriptSnapshot`。
- 生产用例:kap-server `/transcript` 冷路径直接读 `<home>/sessions/<wd>/<sid>/agents/<aid>/wire.jsonl`(`kap-server/src/services/transcript/transcriptService.ts:53-56, 452-463`)+ 上述两函数 fold(`:520-527`);其行读取器 `wireRecords.ts:8-27` 同样是 v1 行规则的拷贝。
- **覆盖差距(事实)**:transcript 的 fold 产出 `AgentTranscriptSnapshot`(渲染模型),**不产出** v1 SDK 契约的 `AgentReplayRecord[]` 与 `toolStore`(`tools.update_store` 的 last-wins store 在 transcript 侧无对应物——`foldFacts` 只把 todo 类事实折进 `TranscriptTodo`)。kap-server 的读取器也不跑 v2 迁移链(直接 JSON.parse)。因此替代方案需要:消费方改吃 transcript 快照,或在 transcript/新位置补一个产 v1 replay 形状的 reducer;`resume-replay.ts:35-46` 的映射表是重写该 reducer 时的核对清单。

## 待核清单

1. `encodeWorkDirKey` 的 v1(resolve 后 hash)/v2(不 resolve)不对称在真实调用链是否可触发不同 bucket:需追踪 kap-server/node-sdk 传入 `createOrTouch` / session create 的 workDir 是否恒为规范化绝对路径(已知入口 `kap-server/src/routes/sessions.ts:240`、`routes/fs.ts:274`、`routes/workspaces.ts:124`)。
2. `sessions/<wd>/<sid>/session-meta/state.json` 兼容读的确切引入版本(推断为早期 v2 布局;jj 历史未在本文内 pinning 到具体 change)。
3. ~~主文档 `migration-from-v1.zh-CN.md:38`「新版本拒读」表述~~（已于 2026-09-19 解决）：主文档已更正为「原样透传、不做迁移」，与本文所循的代码事实一致。
4. `test/wire/wire-compat.test.ts` 仅 pin v2 自身写→读 round-trip;v1↔v2 交叉读取(v1 fold 1.5 journal)目前只靠 `resume-replay.ts` 运行时容错(EMPTY_FOLD)兜底,未见专门交叉兼容测试。
