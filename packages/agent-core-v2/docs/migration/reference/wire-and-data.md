# Wire and on-disk data: journals, migration chain, repair, and the `~/.kimi-code` layout

Date: 2026-09-19. Code baseline: `ccf3d5d6` (the direct parent of #3542, the commit that deleted v1 on main). At this commit v1 `@moonshot-ai/agent-core` 0.15.8 and v2 `@moonshot-ai/agent-core-v2` 0.4.3 coexist; every path and symbol in this document was verified against that baseline. All paths are written from the repository root. Sub-document of [`migration-from-v1.md`](../../migration-from-v1.md); Chinese mirror: [`wire-and-data.zh-CN.md`](wire-and-data.zh-CN.md).

## 0. The two wire implementations side by side

| Concern | v1 (`packages/agent-core`, 0.15.8) | v2 (`packages/agent-core-v2`, 0.4.3) |
|---|---|---|
| Protocol version constant | `AGENT_WIRE_PROTOCOL_VERSION = '1.4'`, `src/agent/records/migration/index.ts:11` | `WIRE_PROTOCOL_VERSION = '1.5'`, `packages/agent-core-v2/src/wire/migration/migration.ts:19` |
| Migration chain | `src/agent/records/migration/{v1.1,v1.2,v1.3,v1.4}.ts` (chains to 1.4) | `src/wire/migration/{v1.1,v1.2,v1.3,v1.4,v1.5}.ts` (chains to 1.5) |
| Read / restore entry | `AgentRecords.replay()`, `src/agent/records/index.ts:283` | `WireService.readJournal()`, `src/wire/wireService.ts:105` |
| Write path | `FileSystemAgentRecordPersistence`, `src/agent/records/persistence.ts:48` | `AppendLogStore` (node-fs), `src/persistence/backends/node-fs/appendLogStore.ts:38` |
| Record shape | `AgentRecord`, `src/agent/records/types.ts` | `WireRecord` (`{type,time?,[key]}`), `src/wire/record.ts:17` |
| Journal file name | `wire.jsonl` (under the agent homedir) | `wire.jsonl`, constant `AGENT_WIRE_RECORD_KEY`, `src/wire/record.ts:3` |

The four v1.0→v1.4 migration steps are **byte-for-byte the same logic** on both sides (only comments and import paths differ; verified with `diff`); v2 adds the v1.4→v1.5 step. A header comment in v1's `v1.3.ts` states explicitly that v1.2→v1.3 is "bump-only" (blobref was introduced without any transformation).

## 1. The v2 migration chain: per-step shape changes, triggers, version determination, failure behavior

### 1.1 What each step changes (`packages/agent-core-v2/src/wire/migration/`)

| Step | File: symbol | Shape change |
|---|---|---|
| 1.0→1.1 | `v1.1.ts:31` `migrateV1_0ToV1_1` | only touches `context.append_message`: `message.toolCalls[]` is flattened from the OpenAI nested form `{type:'function',id,function:{name?,arguments?}}` into `{type,id,name,arguments}` (all other fields spread-kept, `v1.1.ts:22-29`). Other records pass through |
| 1.1→1.2 | `v1.2.ts:33` `migrateV1_1ToV1_2` | only touches `permission.record_approval_result` records with `result.decision==='approved'`, `result.scope==='session'` and no `sessionApprovalRule` yet: backfills `sessionApprovalRule` per `LEGACY_SESSION_APPROVAL_ACTION_TO_PATTERN` (v1.2.ts:20-26, `'run command'→'Bash'`, `'edit file'/'write file'/'edit file outside of working directory'→'Write'`, `'stop background task'→'TaskStop'`); actions outside the table fall back to `toolName`; `'run command in plan mode'`/`'run background command'` belong to `LEGACY_SESSION_APPROVAL_UNRESTORABLE_ACTIONS` (v1.2.ts:28-31) and are not backfilled |
| 1.2→1.3 | `v1.3.ts:3` | identity (bump-only; blobref is handled transparently by the read/write layer) |
| 1.3→1.4 | `v1.4.ts:46` `migrateV1_3ToV1_4` | the goal domain goes multi-goal→single-goal: `goal.create` keeps `goalId/objective/completionCriterion/time`; `goal.update` **drops `goalId`**, keeping only `status/reason/turnsUsed/tokensUsed/wallClockMs/actor/time`; `goal.account_usage`→rewritten as `goal.update{tokensUsed,wallClockMs,time}`; `goal.continuation`→`goal.update{turnsUsed,time}`; `goal.clear` drops `goalId`, keeping only `time` (v1.4.ts:67-112) |
| 1.4→1.5 | `v1.5.ts:3` `migrateV1_4ToV1_5` | for goal records that "advance the activity window" (`goal.create`, or `goal.update` with `status==='active'` or with `status===undefined && typeof wallClockMs==='number'`, `v1.5.ts:14-21`) that have no `wallClockResumedAt` yet and whose `time` is a number: fills `wallClockResumedAt = time` |

Chain registration: `MIGRATIONS` at `migration.ts:29-35`; version comparison: `compareWireVersions` (`migration.ts:96-107`, numeric segment-by-segment).

### 1.2 Trigger points (the read path)

Migration happens only inside `WireService.readJournal()` (`wireService.ts:105-191`), which has two callers:

- Cold restore: `EventDispatcherService.restore()` (`src/state/eventDispatcherService.ts:776-827`) iterates `readJournal()`, skips `metadata`, turns records back into events per the `folded.events` registry with `executeEvent(event, true)`; triggered by `AgentLifecycleService.doCreate`'s `stage='restore'` (`src/session/agentLifecycle/agentLifecycleService.ts:209-210`; the preceding `stage='seal'` calls `IWireService.seal()`, `:194`).
- Late-bound durable participant: `EventDispatcherService.attachLate()` (`eventDispatcherService.ts:266-315`) does the same full fold.

Note: **the fork path does not run migrations** — `SessionLifecycleService.readSourceWireRecords` (`src/workspace/sessionLifecycle/sessionLifecycleService.ts:764-801`) collects records as-is via `appendLogStore.read` (truncation repair only) and `rewrite`s them into the target journal (`:761`); migration is deferred until the forked agent's first restore.

### 1.3 Version determination (the first-valid-record branch of `readJournal`, `wireService.ts:130-148`)

- The first record passing `isWireRecord` (`record.ts:29`) decides the migration set `migrations` for the whole run:
  - `type !== 'metadata'` (an ancient journal with no metadata) → treated as 1.4: **only `migrateV1_4ToV1_5` is applied**, with `rewrittenRecords=[createWireMetadataRecord()]` preset (`:132-134`);
  - `type==='metadata'` but fields incomplete (`isWireMetadataRecord` fails, `record.ts:46`) → throws `StorageError(STORAGE_CORRUPTED,'Agent wire metadata is malformed')` (`:135-140`), a hard read-path failure;
  - `isNewerWireVersion(protocol_version)` (newer than 1.5) → `newerWireVersion=true`: **no migration, no plan normalization, no rewrite** — records are yielded as-is (`:141-143, 151-166`); **note: this is not a refusal** — an earlier revision of the main document `packages/agent-core-v2/docs/migration-from-v1.zh-CN.md:38` said "newer versions are refused", which does not match the code; the main document has been corrected to pass-through on 2026-09-19 (this document follows the code fact). v1's symmetric behavior is to warn and replay anyway (`src/agent/records/index.ts:302-304`);
  - otherwise `resolveWireMigrations(protocol_version)` (`migration.ts:41-62`); if the version ≠ 1.5, `rewrittenRecords=[]` is prepared for a rewrite.
- Every record is folded through the whole chain in order by `migrateWireRecord`; when not newer, a `metadata` record's `protocol_version` is rewritten to the current version (`:151-155`).
- Unknown sourceVersion (no chain start) → `WireError(WIRE_MIGRATION_MISSING)` (`migration.ts:50-56`, `errors.ts` code `wire.migration_missing`, action text "start a new session"), thrown out of `readJournal` → `restore()` fails → agent create fails at `stage='restore'` (`agentLifecycleService.ts:216-219` records `agent_create_failed` telemetry and rethrows).

### 1.4 Other read-path normalization and failure behavior

- Non-wire-shaped lines (no `type:string`) → `reportSkippedRecord` (`wireService.ts:124-127, 330-342`): only reported via `onUnexpectedError(WireError WIRE_UNKNOWN_RECORD)`, then skipped.
- Legacy `plan.revision` shape normalization (`normalizePlanRevisionRecord`, `:297-328`): records missing `key` but carrying `path` get their absolute/relative path of the form `sessions/<ws>/<sid>/agents/<agentId>/plan/<id>/v<N>.md` folded into the scoped key `plan/<id>/v<N>.md` by `extractLegacyPlanRevisionKey` (`:360-374`) (backslashes, too few segments, agentId mismatch, or a failing regex → the record is dropped and telemetry `wire_plan_revision_migrated` records outcome `skipped`). If such normalization happened while `rewrittenRecords` was undefined, `rebuildRewriteRecords` (`:272-295`) re-reads everything after the pass and rewrites.
- Post-read persistence (`:178-190`): if truncated → `repairJournal`; otherwise if `rewrittenRecords !== undefined` (version migration / metadata backfill / empty journal) → `log.rewrite` atomically rewrites the whole journal and resets `lines`/`lastClearLine`; an empty journal (0 records) → rewritten as a single new metadata line.
- `seal()` (`:64-71`): appends a current-version metadata record if the journal is empty; runs on every agent create (idempotent).

## 2. `wire/repair.ts`: triggers and behavior

### 2.1 Trigger conditions

The underlying signal comes from `AppendLogStore.read`'s line parsing (`persistence/backends/node-fs/appendLogStore.ts:58-94`):

- A mid-file line fails `JSON.parse` → `onTruncate({lineNumber, reason:'corrupted', cause})` and **reading stops**; without an `onTruncate` callback it throws `AppendLogCorruptedError` (`interface/appendLogStore.ts:7-19`, code `storage.corrupted`).
- A non-empty, unparseable tail at end of file (a trailing partial line without `\n`) → treated as a crashed half-write, `onTruncate({lineNumber, reason:'truncated'})` (`appendLogStore.ts:84-93`); a parseable last line yields normally.
- The `AppendLogTruncation` type: `interface/appendLogStore.ts:25-29`.

Two trigger points:

1. resume/read path: `WireService.readJournal` calls `repairJournal` after collecting a truncation (`wireService.ts:184-185, 205-237`).
2. fork path: `readSourceWireRecords` repairs the **source** journal directly upon truncation (`sessionLifecycleService.ts:786-799`).

### 2.2 Behavior (`repair.ts:20-64` `repairWireJournal`)

1. `storage.read(scope,key)` reads the raw bytes; `countJournalLines` counts lines by `0x0A`; `droppedCount = max(0, original line count - valid record count)` (`:66-78`).
2. Backup: if `wire.jsonl.bak` (`wireJournalBackupKey`, `repair.ts:16-18`) does not exist → the raw bytes are **atomically written** to `.bak` in the same scope (never overwritten once present, `:37-40`).
3. `appendLog.rewrite(scope,key,records)` atomically rewrites the valid prefix back into the journal (`:42`; rewrite is `storage.write(..., {atomic:true})` underneath, `appendLogStore.ts:113-133`).
4. Any exception → `outcome='failed'`, but **never thrown**; `log.warn('corrupted wire journal truncated to its valid prefix', ...)` + telemetry `track2('wire_repair', {kind: truncation.reason, outcome, dropped_count, backup_created})` (`:47-62`). Returns `'repaired'|'failed'`.

### 2.3 Pending repair after failure (wireService path only)

`repairJournal` stores the failure in `pendingRepair` (`wireService.ts:232`); every subsequent `appendRecord` first retries via `repairPendingJournal()` (`:90-98, 239-258`); if the retry still fails, `persistError = WireError(RECORDS_WRITE_FAILED)` is set and thrown, and that append never lands; `flush()` (`:264-270`) rethrows the pending `persistError` (once). A successful repair resets `lines`/`lastClearLine` (`:233-236`).

Contrast with v1: v1 has no repair; `FileSystemAgentRecordPersistence` throws directly on mid-file corruption (`persistence.ts:210-217`), silently tolerates a truncated tail (`:201-219`), so resume fails.

## 3. v2 persistence and the `~/.kimi-code` disk layout (vs v1)

### 3.1 Root and scope resolution chain

- homeDir: `resolveKimiHome` = `homeDir ?? KIMI_CODE_HOME ?? <osHome>/.kimi-code` (`src/app/bootstrap/bootstrap.ts:163-169`); `FileStorageService` uses homeDir as baseDir, dirMode `0o700` / fileMode `0o600` (the `storageSeed` at `bootstrap.ts:146-152`); `pathFor(scope,key)=join(baseDir,scope,key)` (`fileStorageService.ts:252-254`).
- The scope chain (all POSIX-style relative paths from homeDir):
  - workspace: `persistenceScope = sessions/<workspaceId>` (`src/workspace/workspaceInstance/workspaceInstanceManagerService.ts:201`; `bootstrap.scope('sessions')='sessions'`, `bootstrapService.ts:45-59`). `workspaceId = encodeWorkDirKey(root)` = `wd_<slug>_<sha256(root)[:12]>` (`src/_base/utils/workdir-slug.ts:17-23`).
  - session: `sessionScopeOf = sessions/<wd>/<sessionId>` (`src/workspace/sessionLifecycle/internal/addressing.ts:7-9`); `sessionDir = <homeDir>/sessions/<wd>/<sid>` (`addressing.ts:11-13`, `sessionLifecycleService.ts:243-244`).
  - agent: `agentScopeOf = <sessionScope>/agents/<agentId>` (`addressing.ts:15-17`; `agentLifecycleService.ts:131`).

### 3.2 Layout table (v2, `<homeDir>` = `~/.kimi-code`)

| Path | Content | Writer (symbol) |
|---|---|---|
| `session_index.jsonl` | global session index, append-only, lines `{sessionId,sessionDir,workDir}`; scope `''` | `SessionLifecycleService.appendSessionIndexEntry` (`sessionLifecycleService.ts:323-331`, via `IAppendLogStore`); `SESSION_INDEX_KEY`, `src/app/workspace/workspaceAlias.ts:8-9` |
| `workspaces.json` | workspace registry `{version:1,workspaces,deleted_workspace_ids}` | `FileWorkspacePersistence` (`src/app/workspace/fileWorkspacePersistence.ts:16-18, 84`), via `IAtomicDocumentStore` (atomic JSON writes, `persistence/backends/node-fs/atomicDocumentStore.ts:86-90`) |
| `sessions/<wd>/<sid>/state.json` | session metadata (`SESSION_META_VERSION = 2`) | `SessionMetadata` (`src/session/sessionMetadata/sessionMetadataService.ts:23, 99`; scope = `ctx.metaScope` = sessionScope, `sessionLifecycleService.ts:245`) |
| `sessions/<wd>/<sid>/session-meta/state.json` | meta from the old v2 layout, read for compatibility only; when read, the archive operation migrates it back to the above and deletes the old file | `legacySessionMetaScopeOf` (`addressing.ts:19-21`); `coldSessionArchive.ts:33-44`; `sessionIndexSource.ts:122-124` has the same two-location fallback |
| `sessions/<wd>/<sid>/agents/<aid>/wire.jsonl` | **agent journal** | `WireService` (`AGENT_WIRE_RECORD_KEY`); `journalPath()` exposes the real path (`wireService.ts:201-203`) |
| `sessions/<wd>/<sid>/agents/<aid>/wire.jsonl.bak` | pre-repair backup (created once) | `repairWireJournal` |
| `sessions/<wd>/<sid>/agents/<aid>/blobs/<sha256>` | media blobs; key = sha256 hex of the base64 payload string; only `data:` URIs >4096B are offloaded | `AgentBlobServiceImpl` (`src/agent/blob/agentBlobServiceImpl.ts:28, 115-134`; scope `agentCtx.scope('blobs')`); the in-record URL is rewritten to `blobref:<mime>;<hash>` (`BLOBREF_PROTOCOL`, `agentBlobService.ts:5`) |
| `sessions/<wd>/<sid>/agents/<aid>/plan/<id>/v<N>.md` | immutable plan revisions | `planService.ts:206-207` (paired with the `key` of `plan.revision` records) |
| `sessions/<wd>/<sid>/agents/<aid>/plans/<id>.md` | current plan file | `planService.ts:239` |
| `sessions/<wd>/<sid>/agents/<aid>/tool-results/…` | over-limit tool results offloaded | `toolResultTruncationService.ts:43` (scope `tool-results`) |
| `sessions/<wd>/<sid>/agents/<aid>/file-history/<hash>@v<N>` | file-history blobs | `fileHistory.ts:60` `FILE_HISTORY_BLOB_PREFIX='file-history'`; `fileHistoryService.ts:417-423, 556` |
| `sessions/<wd>/<sid>/tool-policy/…` | session tool policy | `sessionToolPolicyService.ts:43` |
| `sessions/<wd>/<sid>/media/…` | session media attachments | `sessionMediaStoreService.ts:38` |
| `cache/query-store/` | **minidb structured read model** (ClusterDb, 16 shards, json codec, `fsyncPolicy:'everysec'`, valueMode memory) | `MiniDbQueryStore` (`src/persistence/backends/minidb/miniDbQueryStore.ts:26-29, 64, 84-94`); session-index collections `session:g<N>` / `sessionCounters:g<N>`, checkpoint `__checkpoint__`, manifest `'sessionIndex'` (`src/app/sessionIndex/sessionIndexModel.ts:3-22`) |
| `search-index/` | global full-text search minidb (kap-server; a separate database) | `searchService.ts:56, 254` (homeDir + `search-index`) |
| `credentials/mcp/…` | MCP OAuth credentials | `mcpConfig/oauthStore.ts:15` |
| `logs/kimi-code.log`, `cache/`, `store/`, `blobs/` (home level) | logs etc.; `storeDir`/`blobsDir` are declared on `IBootstrapService` and exposed via the klient env contract, but have no writer inside agent-core-v2 src (only `cacheDir` is used, by the query store) | `bootstrapService.ts:45-49`; `klient/src/contract/global/env.ts:34-37` |

Write primitives: `FileStorageService` (`fileStorageService.ts`) — `write`/`writeStream` go through `atomicWrite` (tmp+rename) + one directory fsync (`syncDirOnce`, `:260-268`); `append` opens an `'a'` handle and `fh.sync()`s after writing (`durable` default true, `:114-140`); `read` has torn-read retries (3×15ms, `:20-21, 38-58`); `watch` is chokidar-based with 150ms debounce (`:183-245`). `AppendLogStore` adds microtask batched writes, an `onDidWrite` event, and refCount retirement (`acquire`/`drainRetirements`) on top.

### 3.3 The two-tier session index (v2-specific)

- **Authoritative source** = `session_index.jsonl` + each session's `state.json` (fan-out scan, `sessionIndexSource.ts:93-154`; concurrency 16).
- **Derived read model** = minidb. `FileSessionIndex` (`sessionIndexService.ts:74`) is gated by the flag `persistence_minidb_readmodel` (env `KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL`, **on by default**, `persistence/backends/minidb/flag.ts:3-11`). `SessionIndexProjector.project(generation)` rebuilds fully into a new generation (`sessionIndexProjector.ts:94-152`, old generations dropped asynchronously); `prepare` uses `sourceMaxMtimeMs` for freshness (`sessionIndexService.ts:162-173`); once ready it reconciles every 60s (`RECONCILE_INTERVAL_MS`, `:52`); when degraded it retries every 5s and **falls back to reading the authoritative source directly** (`withReadModel`, `:322-355`); a corrupt minidb (SyntaxError/CorruptFrameError) is `rm -rf`'d wholesale and rebuilt (`miniDbQueryStore.ts:41-43, 96-112`). On the write side, `SessionIndexMirror` batches live changes into the read model every 100ms/500 entries (`sessionIndexMirrorService.ts:20-79`).

### 3.4 Layout differences vs v1

| Item | v1 | v2 | Difference |
|---|---|---|---|
| home | `~/.kimi-code` (KIMI_CODE_HOME) | same | none |
| global session index | `<home>/session_index.jsonl`, same line shape, plus tombstone lines `{sessionId,deleted:true}` (`src/agent-core/src/session/store/session-index.ts:13-16, 39-44`) | same path, same line shape; **v2 writes no deletion tombstones** (deletion goes through read-model evict / directory removal); v2's `parseSessionIndexLine` does not recognize the `deleted` field (`workspaceAlias.ts:85-105`) | read-compatible (v2 skips unparseable lines); deletion semantics differ |
| workspace registry | `<home>/workspaces.json`, `{version:1,workspaces,deleted_workspace_ids}` (`src/agent-core/src/session/store/workspace-registry-file.ts:10-38`, comment states "v1-compatible, v2 reads and writes the same file") | same file, same shape (`fileWorkspacePersistence.ts:16-18, 69-86`) | none (shared contract) |
| workspaceId/bucket | `wd_<slug>_<sha256[:12]>`, hash input is `normalizeWorkDir(workDir)` (resolved) (`src/agent-core/src/session/store/workdir-key.ts:10-22`); a `resolveWorkspaceId` registry hook takes precedence (`session-store.ts:92-102`) | `wd_<slug>_<sha256[:12]>`, hash input only gets `\`→`/` and trailing-slash stripping, **not resolved** (`_base/utils/workdir-slug.ts:17-23`); alias merging by `collectAliasIds`/`dedupeByRoot` (`workspaceAlias.ts:19-56`) + `workspaceRootKey` (Windows case folding) | identical results for already-normalized absolute paths; relative/unnormalized inputs land in different buckets (**unverified**: whether kap-server's `createOrTouch` call sites always pass normalized absolute paths was not traced one by one, e.g. `kap-server/src/routes/sessions.ts:240`) |
| session directory | `<home>/sessions/<wd>/<sid>/`, `state.json` at the directory root (`session-store.ts:81, 201`) | same | none (v2 additionally reads the old v2 `session-meta/state.json` for compatibility, see 3.2) |
| wire journal | `<sessionDir>/agents/<aid>/wire.jsonl` (`session-store.ts:588`; `agent/index.ts:224`) | same path | none |
| blobs | `<agentHomedir>/blobs/<sha256>` (`agent/index.ts:217-219`; threshold 4096, same blobref protocol, `records/blobref.ts:7-11`) | same path, same threshold, same hash input (the base64 string) (v2 `agentBlobServiceImpl.ts:14, 128-134`) | none |
| structured index / search | no minidb; listing scans `session_index.jsonl`+`state.json` directly (`session-store.ts:430-441`) | minidb read model (`cache/query-store`) + kap-server full-text database (`search-index/`) | new in v2, safe to delete and rebuild |
| protocol version | 1.4 | 1.5 | the v2 chain is a superset of v1's (adds 1.4→1.5) |

## 4. node-sdk `src/v2/resume-replay.ts`'s v1 dependency points

### 4.1 What it does

`foldAgentWireReplay(wirePath)` (`packages/node-sdk/src/v2/resume-replay.ts:104-121`): readFile reads v2's `<sessionDir>/agents/<aid>/wire.jsonl` → `parseWireRecords` (`:128-142`, a replica of v1's line rules: blank lines skipped, truncated tail tolerated, mid-file corruption throws) → fed to a **throwaway v1 `Agent`** (in-memory read-only persistence, `ReadOnlyAgentRecordPersistence`, `:81-97`) → `agent.resume({rewriteMigratedRecords:false})` → takes `agent.replayBuilder.buildResult()` and `agent.tools.storeData()` as the v1-contract `ResumedAgentState.replay` / `toolStore`. Any exception → `EMPTY_FOLD` (`:71, 118-120`). Sole call site: `sdk-rpc-client-v2.ts:1166` (`resumedAgentState`), results consumed at `:1188, 1197`; the replay is then truncated with v1's `limitAgentReplayByTurns` (`src/agent-core/src/agent/replay/turns.ts:56`).

### 4.2 The exact v1 symbols and semantics it depends on (why "the fold must use v1")

- Imports (`resume-replay.ts:58-63`): `Agent`, `type AgentRecord`, `type AgentRecordPersistence`, `type AgentReplayRecord` — all from the `@moonshot-ai/agent-core` package root (node-sdk `package.json:62`, inside the `devDependencies` block, lists `"@moonshot-ai/agent-core": "workspace:^"`).
- The behaviors it relies on (the file header comment `:1-54` says so; everything checkable in code):
  - the restore mega-switch in `AgentRecords.replay` (`src/agent-core/src/agent/records/index.ts:32-178`): each record type calls the corresponding subdomain's restore method (`context.appendMessage`, `permission.setMode`, `goal.restoreCreate/Update/Clear`, etc.) — that switch is the entire semantics of the fold.
  - version handling: a v2 journal is 1.5, v1 only knows up to 1.4 → the `isNewerWireVersion` branch only warns and replays as-is (`records/index.ts:302-304`); v1.5's new `wallClockResumedAt` is an unknown pass-through field to v1 (v1's `GoalState` already has that field, `src/agent-core/src/agent/goal/index.ts:291`, compatible).
  - `ContextMemory.finishResume()` / `TurnFlow.finishResume()` (`agent/index.ts:542-543`): at the end of resume they synthesize interrupted tool-result records — inside the fold those appends land in the in-memory buffer and never touch disk (`resume-replay.ts:48-53, 73-80`).
  - `ReplayBuilder` (`agent/index.ts:165, 250`; `finishRestoringRecord` decides replay-record output) and `ToolManager.storeData()`.
  - The comment states the reason for not reimplementing (`:11-18`): the subtle semantics of assembling assistant messages from loop events (`step.begin` opens a message, `content.part`/`tool.call` mutate in place, `tool.result` closes, gaps get interrupted results, deferred flush), `context.undo`, and `context.apply_compaction` patching — a reimplementation would drift.
  - The record-type→replay mapping table is written at `:20-46` (can be lifted straight into a reference): `profile.bind` maps back to `config.update`+`tools.set_active_tools` in the v1 restore but produces no `config_updated` replay record (`records/index.ts:51-72`); `tools.update_store` produces no replay record and goes last-wins into toolStore; v2-only records (`plan.revision`, `task.*`, `skill.activate`, `interaction.*`, `token_counting.*`, `llm.*`) fall outside the v1 switch and are ignored.

### 4.3 The breakage after v1's deletion, and what `packages/transcript` can replace

Breakage: the whole file loses its compile-time dependencies (`Agent` / the restore switch / ReplayBuilder / `ToolManager.storeData` exist only in v1); `sdk-rpc-client-v2.ts` has additional v1 imports (`:140-152`'s `limitAgentReplayByTurns`, `KimiError`, `ensureConfigFile`, etc.), but the fold is the only **behavioral** dependency. The main document already lists it as outstanding debt (`docs/migration-from-v1.zh-CN.md:130, 237`).

`@moonshot-ai/transcript` (packages/transcript; pure TS, no engine dependency; node-sdk currently does **not** depend on it — no entry in `package.json`) already has a wire→render-model fold:

- `foldWireRecordFacts(records: Iterable<HistoryWireRecord>, base: AgentTranscriptSnapshot, options?)` (`src/history/foldFacts.ts:222-226`): wire records → transcript fact layer (items/markers/taskrefs, tasks, interactions, todo, goal, plan/swarm/tower mode, undo anchor); `HistoryWireRecord` is structurally the same shape as v2 `WireRecord` (`foldFacts.ts:9-13`).
- `groupMessagesIntoSnapshot(messages, options?)` (`src/history/groupTurns.ts:69-75`): a `context.append_message` message list → a turn/step/frame-structured `AgentTranscriptSnapshot`.
- Production use: kap-server's `/transcript` cold path reads `<home>/sessions/<wd>/<sid>/agents/<aid>/wire.jsonl` directly (`kap-server/src/services/transcript/transcriptService.ts:53-56, 452-463`) and folds with the two functions above (`:520-527`); its line reader `wireRecords.ts:8-27` is likewise a copy of v1's line rules.
- **Coverage gap (fact)**: transcript's fold produces `AgentTranscriptSnapshot` (a render model); it does **not** produce the v1 SDK contract's `AgentReplayRecord[]` or `toolStore` (the `tools.update_store` last-wins store has no counterpart on the transcript side — `foldFacts` only folds todo-like facts into `TranscriptTodo`). Nor does kap-server's reader run the v2 migration chain (it JSON.parses directly). A replacement therefore requires either consumers switching to transcript snapshots, or a new reducer in transcript/elsewhere that produces the v1 replay shape; the mapping table at `resume-replay.ts:35-46` is the checklist for rewriting that reducer.

## Open verification items

1. Whether the `encodeWorkDirKey` v1/v2 asymmetry (hash after resolve vs no resolve) can actually route to different buckets on real call chains: trace whether the workDir passed into `createOrTouch` / session create by kap-server/node-sdk is always a normalized absolute path (known entry points `kap-server/src/routes/sessions.ts:240`, `routes/fs.ts:274`, `routes/workspaces.ts:124`).
2. The exact version in which the `sessions/<wd>/<sid>/session-meta/state.json` compatibility read was introduced (presumed an early v2 layout; jj history not pinned to a specific change in this report).
3. ~~The main document `migration-from-v1.zh-CN.md:38`'s "newer versions are refused" wording~~ (resolved 2026-09-19): the main document has been corrected to "passed through un-migrated", matching the code fact followed by this document.
4. `test/wire/wire-compat.test.ts` only pins v2's own write→read round-trip; v1↔v2 cross-reading (v1 folding a 1.5 journal) currently relies only on `resume-replay.ts`'s runtime tolerance (EMPTY_FOLD) — no dedicated cross-compatibility test seen.
