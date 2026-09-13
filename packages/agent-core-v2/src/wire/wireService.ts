import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ContentPart } from '#human/llm/message';
import {
  type AppendLogTruncation,
  IAppendLogStore,
} from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';

import { IWireService } from './wire';
import { WireError, WireErrors } from './errors';
import { isHumanRecordType } from './human';
import {
  type AgentJournalRef,
  type IAgentJournal,
  type SwitchedBranch,
  type SwitchBranchInput,
} from './journal';
import { repairWireJournal } from './repair';
import {
  activeChain,
  AGENT_SWITCHED_TYPE,
  branchForLine,
  buildUndoSwitchRecords,
  computeForkLine,
  MAIN_BRANCH,
  parseTree,
  restorableChain,
  type UndoSwitchRecords,
  type WireLine,
  type WireTree,
} from './tree';
import {
  WIRE_PROTOCOL_VERSION,
  isNewerWireVersion,
  migrateV1_4ToV1_5,
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
} from './migration/migration';
import {
  AGENT_WIRE_RECORD_KEY,
  createWireMetadataRecord,
  isWireRecord,
  isWireMetadataRecord,
  type PartsTransformer,
  type RecordDehydrator,
  type WireRecord,
} from './record';

export class WireService extends Service implements IWireService, IAgentJournal {
  declare readonly _serviceBrand: undefined;

  private readonly wireScope: string;
  private lines = 0;
  private lastClearLine: number | undefined;
  private readonly agentId: string;
  private persistQueue: Promise<void> | undefined;
  private pendingRepair:
    | { readonly records: WireRecord[]; readonly truncation: AppendLogTruncation }
    | undefined;
  private persistError: Error | undefined;
  private treeSnapshot: WireTree | undefined;
  private writeGeneration = 0;
  private lastReadLineCount = 0;
  private modeTwoEntries: WireLine[] = [];

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAppendLogStore private readonly log: IAppendLogStore,
    @IAgentBlobService private readonly blobService: IAgentBlobService,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @ILogService private readonly logger: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this.wireScope = scopeContext.scope();
    this.agentId = scopeContext.agentId;
    this._register(this.log.acquire(this.wireScope, AGENT_WIRE_RECORD_KEY));
  }

  async seal(): Promise<void> {
    const tolerate = { onTruncate: () => {} };
    for await (const record of this.log.read(this.wireScope, AGENT_WIRE_RECORD_KEY, tolerate)) {
      void record;
      return;
    }
    this.appendRecordLow(createWireMetadataRecord());
  }

  appendRecord(record: WireRecord, dehydrate?: RecordDehydrator): void {
    if (
      this.pendingRepair === undefined &&
      dehydrate === undefined &&
      this.persistQueue === undefined
    ) {
      try {
        this.appendRecordLow(record);
      } catch (error) {
        onUnexpectedError(error);
      }
      return;
    }
    const transform: PartsTransformer = (parts) =>
      this.blobService.offloadParts(
        parts as readonly ContentPart[],
      ) as Promise<readonly unknown[]>;
    const queued = (this.persistQueue ?? Promise.resolve())
      .then(async () => {
        if (this.pendingRepair !== undefined) {
          await this.repairPendingJournal();
        }
        const output = dehydrate === undefined ? record : await dehydrate(record, transform);
        this.appendRecordLow(output);
      })
      .catch((error: unknown) => onUnexpectedError(error));
    this.persistQueue = queued;
    void queued.then(() => {
      if (this.persistQueue === queued) this.persistQueue = undefined;
    });
  }

  async *readJournal(): AsyncIterable<WireRecord> {
    for await (const { record } of this.readEntries()) {
      yield record;
    }
  }

  get journalRef(): AgentJournalRef {
    return { tree: this.wireScope, branch: this.treeSnapshot?.activeBranch ?? MAIN_BRANCH };
  }

  append(record: WireRecord, dehydrate?: RecordDehydrator): void {
    this.appendRecord(record, dehydrate);
  }

  async *read(): AsyncIterable<WireRecord> {
    const entries = await this.readStableEntries();
    const tree = parseTree(entries, entries.at(-1)?.line ?? 0);
    this.treeSnapshot = tree;
    this.reportTreeDiagnostics(tree);
    for (const { record } of activeChain(entries, tree)) {
      yield record;
    }
  }

  readRaw(): AsyncIterable<WireRecord> {
    return this.readJournal();
  }

  readHumanChain(): readonly WireLine[] {
    const tree = parseTree(this.modeTwoEntries, this.lines);
    return activeChain(this.modeTwoEntries, tree);
  }

  async *readRestorable(): AsyncIterable<WireRecord> {
    const entries = await this.readStableEntries();
    const tree = parseTree(entries, entries.at(-1)?.line ?? 0);
    this.treeSnapshot = tree;
    this.reportTreeDiagnostics(tree);
    for (const { record } of restorableChain(entries, tree)) {
      yield record;
    }
  }

  async switchBranch(input: SwitchBranchInput): Promise<SwitchedBranch> {
    let entries: WireLine[] | undefined;
    for (let attempt = 0; attempt < 2 && entries === undefined; attempt++) {
      await this.drainPersisted();
      const read = await this.readStableEntries();
      if (this.lines === this.lastReadLineCount) entries = read;
    }
    if (entries === undefined) {
      throw new WireError(
        WireErrors.codes.RECORDS_WRITE_FAILED,
        'Wire journal changed while switching branches',
        { details: { scope: this.wireScope, lines: this.lines, read: this.lastReadLineCount } },
      );
    }
    const lastLine = entries.at(-1)?.line ?? 0;
    const tree = parseTree(entries, lastLine);
    this.reportTreeDiagnostics(tree);
    const forkLine = computeForkLine(
      activeChain(entries, tree),
      tree.pairedLegacyUndoLines,
      input.turns,
    );
    const base = { branch: branchForLine(tree, forkLine), line: forkLine };
    const branch = `b${tree.edges.length + 1}`;
    const edgeLine = this.lines + 1;
    const records = buildUndoSwitchRecords({
      agentId: this.agentId,
      branch,
      reason: input.reason ?? 'undo',
      base,
      turns: input.turns,
      edgeLine,
      fromTurnId: input.fromTurnId,
      time: Date.now(),
    });
    this.appendRecord(records.switched);
    this.appendRecord(records.legacyUndo);
    this.appendRecord(records.undone);
    await this.flush();
    await this.assertSwitchTripleAppended(records, edgeLine);
    const appended: WireLine[] = [
      { record: records.switched, line: edgeLine },
      { record: records.legacyUndo, line: edgeLine + 1 },
      { record: records.undone, line: edgeLine + 2 },
    ];
    this.treeSnapshot = parseTree([...entries, ...appended], edgeLine + 2);
    return { branch, base, edgeLine, forkLine };
  }

  private async assertSwitchTripleAppended(
    records: UndoSwitchRecords,
    edgeLine: number,
  ): Promise<void> {
    const tail: WireRecord[] = [];
    let total = 0;
    const tolerate = { onTruncate: () => {} };
    for await (const record of this.log.read<WireRecord>(
      this.wireScope,
      AGENT_WIRE_RECORD_KEY,
      tolerate,
    )) {
      total += 1;
      tail.push(record);
      if (tail.length > 3) tail.shift();
    }
    const expected = [records.switched, records.legacyUndo, records.undone];
    const matches =
      total === edgeLine + 2 &&
      tail.length === 3 &&
      tail.every((record, index) => recordsMatch(record, expected[index]!));
    if (matches) return;
    throw new WireError(
      WireErrors.codes.RECORDS_WRITE_FAILED,
      'Wire journal changed while the undo switch triple was appended',
      { details: { scope: this.wireScope, lines: total, edgeLine } },
    );
  }

  private async readStableEntries(): Promise<WireLine[]> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = this.writeGeneration;
      const entries: WireLine[] = [];
      for await (const entry of this.readEntries()) {
        entries.push(entry);
      }
      if (this.writeGeneration === generation) return entries;
    }
    throw new WireError(
      WireErrors.codes.RECORDS_WRITE_FAILED,
      'Wire journal kept rewriting while being read',
      { details: { scope: this.wireScope } },
    );
  }

  private reportTreeDiagnostics(tree: WireTree): void {
    for (const line of tree.diagnostics.malformedSwitchLines) {
      onUnexpectedError(
        new WireError(
          WireErrors.codes.WIRE_UNKNOWN_RECORD,
          'Malformed agent.switched record ignored during tree projection',
          { details: { scope: this.wireScope, type: AGENT_SWITCHED_TYPE, line } },
        ),
      );
    }
    for (const branch of tree.diagnostics.duplicateBranches) {
      onUnexpectedError(
        new WireError(
          WireErrors.codes.WIRE_UNKNOWN_RECORD,
          `Duplicate agent.switched branch '${branch}' ignored during tree projection`,
          { details: { scope: this.wireScope, type: AGENT_SWITCHED_TYPE, branch } },
        ),
      );
    }
  }

  branches(): readonly string[] {
    const tree = this.treeSnapshot;
    if (tree === undefined) return [MAIN_BRANCH];
    return tree.segments.map((segment) => segment.branch);
  }

  nextSeq(): number {
    return this.lines + 1;
  }

  settled(): Promise<void> {
    return this.drainPersisted();
  }

  private async *readEntries(): AsyncIterable<WireLine> {
    let truncation: AppendLogTruncation | undefined;
    const source = this.log.read<WireRecord>(this.wireScope, AGENT_WIRE_RECORD_KEY, {
      onTruncate: (info) => {
        truncation = info;
      },
    });
    let migrations: readonly WireMigration[] = [];
    let rewrittenRecords: WireRecord[] | undefined;
    let newerWireVersion = false;
    let recordIndex = 0;
    let lineCount = 0;
    let hasRecords = false;
    let legacyPlanRevisionMigrated = false;
    const modeTwoEntries: WireLine[] = [];
    const modeTwoLengthAtStart = this.modeTwoEntries.length;

    for await (const candidate of source) {
      lineCount++;
      this.lines = lineCount;
      const sourceRecord: unknown = candidate;
      if (!isWireRecord(sourceRecord)) {
        this.reportSkippedRecord(undefined, recordIndex, true);
        recordIndex++;
        continue;
      }
      if (sourceRecord.type === 'context.clear') this.lastClearLine = lineCount;
      if (!hasRecords) {
        hasRecords = true;
        if (sourceRecord.type !== 'metadata') {
          rewrittenRecords = [createWireMetadataRecord()];
          migrations = [migrateV1_4ToV1_5];
        } else if (!isWireMetadataRecord(sourceRecord)) {
          throw new StorageError(
            StorageErrors.codes.STORAGE_CORRUPTED,
            'Agent wire metadata is malformed',
            { details: { scope: this.wireScope, key: AGENT_WIRE_RECORD_KEY } },
          );
        } else if (isNewerWireVersion(sourceRecord.protocol_version)) {
          newerWireVersion = true;
        } else {
          migrations = resolveWireMigrations(sourceRecord.protocol_version);
          if (sourceRecord.protocol_version !== WIRE_PROTOCOL_VERSION) {
            rewrittenRecords = [];
          }
        }
      }

      const migratedRecord = migrateWireRecord(sourceRecord, migrations);
      const record =
        !newerWireVersion && migratedRecord.type === 'metadata'
          ? { ...migratedRecord, protocol_version: WIRE_PROTOCOL_VERSION }
          : migratedRecord;
      const normalized = newerWireVersion
        ? record
        : this.normalizePlanRevisionRecord(record, recordIndex);
      if (
        !newerWireVersion &&
        record.type === 'plan.revision' &&
        normalized !== undefined &&
        'path' in record &&
        !('key' in record)
      ) {
        legacyPlanRevisionMigrated = true;
      }
      if (normalized === undefined) {
        if (record.type === 'plan.revision') recordIndex++;
        continue;
      }
      rewrittenRecords?.push(normalized);
      if (isHumanRecordType(normalized.type) || normalized.type === AGENT_SWITCHED_TYPE) {
        modeTwoEntries.push({ record: normalized, line: lineCount });
      }
      yield { record: normalized, line: lineCount };
      if (normalized.type !== 'metadata') {
        recordIndex++;
      }
    }

    if (legacyPlanRevisionMigrated && rewrittenRecords === undefined) {
      rewrittenRecords = await this.rebuildRewriteRecords(migrations, newerWireVersion);
    }
    if (!hasRecords) {
      rewrittenRecords = [createWireMetadataRecord()];
    }
    if (truncation !== undefined) {
      await this.repairJournal(truncation, rewrittenRecords);
    } else if (rewrittenRecords !== undefined) {
      await this.log.rewrite(this.wireScope, AGENT_WIRE_RECORD_KEY, rewrittenRecords);
      this.writeGeneration += 1;
      this.lines = rewrittenRecords.length;
      this.lastClearLine = lastContextClearLineOf(rewrittenRecords);
    }
    this.mergeModeTwoEntries(modeTwoEntries, this.modeTwoEntries.slice(modeTwoLengthAtStart), lineCount);
    this.lastReadLineCount = lineCount;
  }

  private mergeModeTwoEntries(
    fresh: WireLine[],
    appended: readonly WireLine[],
    lineCount: number,
  ): void {
    let line = lineCount;
    const merged = [...fresh];
    for (const entry of appended) {
      if (fresh.some((candidate) => recordsMatch(candidate.record, entry.record))) continue;
      line += 1;
      merged.push({ record: entry.record, line });
    }
    this.modeTwoEntries = merged;
  }

  lineCount(): number {
    return this.lines;
  }

  lastContextClearLine(): number | undefined {
    return this.lastClearLine;
  }

  journalPath(): string | undefined {
    return this.storage.pathFor(this.wireScope, AGENT_WIRE_RECORD_KEY);
  }

  private async repairJournal(
    truncation: AppendLogTruncation,
    rewrittenRecords: WireRecord[] | undefined,
  ): Promise<void> {
    let records: WireRecord[] = rewrittenRecords ?? [];
    if (rewrittenRecords === undefined) {
      const tolerate = { onTruncate: () => {} };
      for await (const record of this.log.read<WireRecord>(
        this.wireScope,
        AGENT_WIRE_RECORD_KEY,
        tolerate,
      )) {
        records.push(record);
      }
    }
    const outcome = await repairWireJournal(
      {
        appendLog: this.log,
        storage: this.storage,
        log: this.logger,
        telemetry: this.telemetry,
      },
      this.wireScope,
      AGENT_WIRE_RECORD_KEY,
      records,
      truncation,
    );
    this.pendingRepair = outcome === 'failed' ? { records, truncation } : undefined;
    if (outcome !== 'failed') {
      this.writeGeneration += 1;
      this.lines = records.length;
      this.lastClearLine = lastContextClearLineOf(records);
    }
  }

  private async repairPendingJournal(): Promise<void> {
    const pending = this.pendingRepair;
    if (pending === undefined) return;
    await this.repairJournal(pending.truncation, pending.records);
    if (this.pendingRepair !== undefined) {
      const error = new WireError(
        WireErrors.codes.RECORDS_WRITE_FAILED,
        'Wire journal repair did not complete; record was not appended',
        {
          details: {
            scope: this.wireScope,
            key: AGENT_WIRE_RECORD_KEY,
            lineNumber: pending.truncation.lineNumber,
          },
        },
      );
      this.persistError = error;
      throw error;
    }
  }

  async drainPersisted(): Promise<void> {
    await this.persistQueue;
  }

  async flush(): Promise<void> {
    await this.persistQueue;
    const persistError = this.persistError;
    this.persistError = undefined;
    if (persistError !== undefined) throw persistError;
    await this.log.flush();
  }

  private async rebuildRewriteRecords(
    migrations: readonly WireMigration[],
    newerWireVersion: boolean,
  ): Promise<WireRecord[]> {
    const records: WireRecord[] = [];
    const tolerate = { onTruncate: () => {} };
    for await (const candidate of this.log.read<WireRecord>(
      this.wireScope,
      AGENT_WIRE_RECORD_KEY,
      tolerate,
    )) {
      if (!isWireRecord(candidate)) continue;
      const migratedRecord = migrateWireRecord(candidate, migrations);
      const record =
        !newerWireVersion && migratedRecord.type === 'metadata'
          ? { ...migratedRecord, protocol_version: WIRE_PROTOCOL_VERSION }
          : migratedRecord;
      const normalized = newerWireVersion
        ? record
        : this.normalizePlanRevisionRecord(record, 0, false);
      if (normalized !== undefined) records.push(normalized);
    }
    return records;
  }

  private normalizePlanRevisionRecord(
    record: WireRecord,
    index: number,
    report = true,
  ): WireRecord | undefined {
    if (record.type !== 'plan.revision' || 'key' in record) return record;
    if (!('path' in record) || typeof record['path'] !== 'string') {
      if (report) {
        this.telemetry.track2('wire_plan_revision_migrated', {
          record_type: 'plan.revision',
          legacy_field: 'path',
          migration_outcome: 'skipped',
        });
        this.reportSkippedRecord(record.type, index, true);
      }
      return undefined;
    }
    const key = extractLegacyPlanRevisionKey(record['path'], this.agentId);
    if (report) {
      this.telemetry.track2('wire_plan_revision_migrated', {
        record_type: 'plan.revision',
        legacy_field: 'path',
        migration_outcome: key === undefined ? 'skipped' : 'migrated',
      });
    }
    if (key === undefined) {
      if (report) this.reportSkippedRecord(record.type, index, true);
      return undefined;
    }
    const { path: _path, ...rest } = record;
    return { ...rest, key };
  }

  private reportSkippedRecord(type: string | undefined, index: number, malformed = false): void {
    onUnexpectedError(
      new WireError(
        WireErrors.codes.WIRE_UNKNOWN_RECORD,
        type === undefined
          ? 'Malformed wire record skipped during restore'
          : malformed
            ? `Malformed wire record type '${type}' skipped during restore`
            : `Unknown wire record type '${type}' skipped during restore`,
        { details: { type, index } },
      ),
    );
  }

  private appendRecordLow(record: WireRecord): void {
    this.log.append(this.wireScope, AGENT_WIRE_RECORD_KEY, record, {
      onError: onUnexpectedError,
    });
    this.lines += 1;
    if (isHumanRecordType(record.type) || record.type === AGENT_SWITCHED_TYPE) {
      this.modeTwoEntries.push({ record, line: this.lines });
    }
    if (record.type === 'context.clear') this.lastClearLine = this.lines;
  }
}

function recordsMatch(a: WireRecord, b: WireRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function lastContextClearLineOf(records: readonly WireRecord[]): number | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]!.type === 'context.clear') return index + 1;
  }
  return undefined;
}

function extractLegacyPlanRevisionKey(path: string, agentId: string): string | undefined {
  if (path.includes('\\')) return undefined;
  const segments = path.split('/');
  if (
    segments.length < 8 ||
    segments[0] !== 'sessions' ||
    segments[3] !== 'agents' ||
    segments[4] !== agentId ||
    segments.slice(1, 3).some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  const key = segments.slice(5).join('/');
  return /^plan\/[^/]+\/v[0-9]+\.md$/.test(key) ? key : undefined;
}
