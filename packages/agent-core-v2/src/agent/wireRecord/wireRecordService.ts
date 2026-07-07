import { relative } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Disposable, toDisposable } from "#/_base/di/lifecycle";
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { OrderedHookSlot } from '#/hooks';
import type { WireRecord, WireRecordMap } from './wireRecord';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  applyWireMigrations,
  isNewerWireVersion,
  resolveWireMigrations,
  type WireMigration,
  type WireMigrationRecord,
} from '#/agent/wireRecord/migration/migration';
import {
  IAgentWireRecordService,
  type PersistedWireRecord,
  type WireRecordBlobSelector,
  type WireRecordMetadata,
  type WireRecordRegisterOptions,
  type WireRecordRestoredContext,
  type WireRecordRestoreOptions,
  type WireRecordRestoreResult,
  type WireRecordServiceOptions,
} from './wireRecord';

type Resumer<T extends keyof WireRecordMap> = (data: WireRecord<T>) => void | Promise<void>;
type BlobSelector<T extends keyof WireRecordMap> = WireRecordBlobSelector<WireRecord<T>>;

export class AgentWireRecordService extends Disposable implements IAgentWireRecordService {
  declare readonly _serviceBrand: undefined;
  private readonly records: WireRecord[] = [];
  private readonly resumers = new Map<keyof WireRecordMap, Set<Resumer<keyof WireRecordMap>>>();
  private readonly blobSelectors = new Map<
    keyof WireRecordMap,
    BlobSelector<keyof WireRecordMap>[]
  >();
  private readonly wireScope: string;
  private _restoring: { time?: number } | null = null;
  private _postRestoring = false;
  readonly hooks = {
    onRestoredRecord: new OrderedHookSlot<WireRecordRestoredContext>(),
    onResumeEnded: new OrderedHookSlot<{}>(),
  };

  constructor(
    private readonly options: WireRecordServiceOptions = {},
    @IBootstrapService bootstrap: IBootstrapService,
    @IAgentBlobService private readonly blobStore?: IAgentBlobService,
    @IAppendLogStore private readonly log?: IAppendLogStore,
  ) {
    super();
    // Each agent scope seeds its own `homedir` (`<homeDir>/sessions/<ws>/<sid>/
    // agents/<aid>`); the wire log is the fixed `wire.jsonl` beneath it. The
    // `IAppendLogStore` is App-scoped (shared, rooted at `homeDir`), so the
    // store `scope` is the homedir made relative to `homeDir` — keeping every
    // agent's records in its own file instead of one shared log.
    this.wireScope = relative(bootstrap.homeDir, options.homedir ?? bootstrap.homeDir);
    if (this.log !== undefined) {
      this._register(this.log.acquire(this.wireScope, WIRE_RECORD_FILENAME));
    }
  }

  get restoring() {
    return this._restoring;
  }

  get postRestoring() {
    return this._postRestoring;
  }

  getRecords(): readonly PersistedWireRecord[] {
    return [...this.records];
  }

  register<T extends keyof WireRecordMap>(
    type: T,
    resumer: (data: WireRecord<T>) => void | Promise<void>,
    options?: WireRecordRegisterOptions<T>,
  ) {
    const typed = resumer as unknown as Resumer<keyof WireRecordMap>;
    let set = this.resumers.get(type);
    if (set === undefined) {
      set = new Set();
      this.resumers.set(type, set);
    }
    set.add(typed);
    const blobSelector = options?.blobs as BlobSelector<keyof WireRecordMap> | undefined;
    const blobSet = this.registerBlobSelector(type, blobSelector);
    return toDisposable(() => {
      set?.delete(typed);
      if (blobSelector !== undefined) {
        const index = blobSet?.indexOf(blobSelector) ?? -1;
        if (index !== -1) blobSet?.splice(index, 1);
      }
    });
  }

  async restore(
    records?: readonly PersistedWireRecord[],
    options: WireRecordRestoreOptions = {},
  ): Promise<WireRecordRestoreResult> {
    const fromPersistence = records === undefined;
    const source =
      records ??
      (this.log !== undefined
        ? this.log.read<PersistedWireRecord>(this.wireScope, WIRE_RECORD_FILENAME)
        : undefined);
    if (source === undefined) {
      await this.runResumeEndedHooks();
      return {};
    }

    const rewriteMigratedRecords =
      fromPersistence && (options.rewriteMigratedRecords ?? true);
    const restoredRecords: PersistedWireRecord[] | undefined =
      rewriteMigratedRecords ? [] : undefined;
    const requireMetadata =
      fromPersistence && this.log !== undefined;
    let migrations: readonly WireMigration[] = [];
    let shouldRewrite = false;
    let completed = true;
    let warning: string | undefined;
    const sourceRecords: PersistedWireRecord[] = [];

    for await (const record of toAsyncIterable(source)) {
      sourceRecords.push(record);
    }

    const firstRecord = sourceRecords[0];
    if (firstRecord !== undefined) {
      if (firstRecord.type === 'metadata') {
        if (!isWireRecordMetadata(firstRecord)) {
          throw new Error('WireRecord restore expected metadata protocol_version');
        }
        const readVersion = firstRecord.protocol_version;
        if (isNewerWireVersion(readVersion)) {
          warning = `Session wire protocol version ${readVersion} is newer than the current version ${AGENT_WIRE_PROTOCOL_VERSION}. Records will be restored without migration.`;
          shouldRewrite = false;
        } else {
          migrations = resolveWireMigrations(readVersion);
          shouldRewrite = readVersion !== AGENT_WIRE_PROTOCOL_VERSION;
        }
      } else if (requireMetadata) {
        throw new Error('WireRecord restore expected metadata as the first record');
      }
    }

    const migratedRecords = applyWireMigrations(
      sourceRecords as WireMigrationRecord[],
      migrations,
    ) as PersistedWireRecord[];
    for (let migratedRecord of migratedRecords) {
      if (migratedRecord.type === 'metadata') {
        migratedRecord = {
          ...migratedRecord,
          protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        };
      }
      restoredRecords?.push(migratedRecord);
      if (migratedRecord.type === 'metadata') continue;

      if (await this.restoreRecord(await this.rehydrateRecord(migratedRecord as WireRecord))) {
        completed = false;
        break;
      }
    }

    if (
      completed &&
      shouldRewrite &&
      restoredRecords !== undefined &&
      this.log !== undefined
    ) {
      void this.log.rewrite(this.wireScope, WIRE_RECORD_FILENAME, restoredRecords);
      await this.log.flush();
    }
    if (completed) {
      await this.runResumeEndedHooks();
    }
    return warning === undefined ? {} : { warning };
  }

  async flush(): Promise<void> {
    await this.log?.flush();
  }

  async close(): Promise<void> {
    await this.log?.close();
  }

  private async restoreRecord(record: WireRecord): Promise<boolean> {
    this.records.push(record);
    this._restoring = { time: record.time ?? Date.now() };
    try {
      const resumers = this.resumers.get(record.type);
      if (resumers !== undefined) {
        const currentResumers = Array.from(resumers);
        for (const resumer of currentResumers) {
          await resumer(record);
        }
      }
      const context: WireRecordRestoredContext = { record, stop: false };
      await this.hooks.onRestoredRecord.run(context);
      return context.stop;
    } finally {
      this._restoring = null;
    }
  }

  private async runResumeEndedHooks(): Promise<void> {
    this._postRestoring = true;
    try {
      await this.hooks.onResumeEnded.run({});
    } finally {
      this._postRestoring = false;
    }
  }

  private registerBlobSelector<T extends keyof WireRecordMap>(
    type: T,
    selector: BlobSelector<keyof WireRecordMap> | undefined,
  ): BlobSelector<keyof WireRecordMap>[] | undefined {
    if (selector === undefined) return undefined;

    let selectors = this.blobSelectors.get(type);
    if (selectors === undefined) {
      selectors = [];
      this.blobSelectors.set(type, selectors);
    }
    selectors.push(selector);
    return selectors;
  }

  private async rehydrateRecord<T extends keyof WireRecordMap>(
    record: WireRecord<T>,
  ): Promise<WireRecord<T>> {
    return this.applyBlobSelectors(record);
  }

  private async applyBlobSelectors<T extends keyof WireRecordMap>(
    record: WireRecord<T>,
  ): Promise<WireRecord<T>> {
    const blobStore = this.blobStore;
    if (blobStore === undefined) return record;

    const selectors = this.blobSelectors.get(record.type);
    if (selectors === undefined) return record;

    let current = record;
    for (const selector of [...selectors] as BlobSelector<T>[]) {
      for (const target of selector(current)) {
        const parts = await blobStore.loadParts(target.parts);
        if (parts !== target.parts) {
          current = target.replace(current, parts);
        }
      }
    }
    return current;
  }
}

async function* toAsyncIterable<T>(
  source: Iterable<T> | AsyncIterable<T>,
): AsyncIterable<T> {
  for await (const item of source) {
    yield item;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentWireRecordService,
  AgentWireRecordService,
  InstantiationType.Delayed,
  'wireRecord',
);

function isWireRecordMetadata(record: PersistedWireRecord): record is WireRecordMetadata {
  return record.type === 'metadata' && typeof record['protocol_version'] === 'string';
}

/**
 * File name of every agent's wire log, written beneath the agent's homedir
 * (`<homeDir>/sessions/<ws>/<sid>/agents/<aid>/wire.jsonl`).
 */
export const WIRE_RECORD_FILENAME = 'wire.jsonl';

/**
 * Store `scope` of an agent's wire log: its homedir made relative to the app
 * `homeDir`. Paired with {@link WIRE_RECORD_FILENAME} by callers that read /
 * rewrite a wire log through `IAppendLogStore` without holding a live agent
 * handle (e.g. session fork).
 */
export function wireRecordScope(homedir: string, homeDir: string): string {
  return relative(homeDir, homedir);
}
