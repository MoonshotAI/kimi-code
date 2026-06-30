import { createHash } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  Disposable,
  toDisposable,
} from "#/_base/di";
import { IBlobStoreService } from '#/blobStore';
import { IBootstrapService } from '#/bootstrap';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { IAppendLogStore } from '#/storage';
import { OrderedHookSlot } from '../hooks';
import type { WireRecord, WireRecordMap } from '../wireRecord';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  applyWireMigrations,
  isNewerWireVersion,
  resolveWireMigrations,
  type WireMigration,
  type WireMigrationRecord,
} from './migration';
import {
  IWireRecord,
  type PersistedWireRecord,
  type WireRecordBlobSelector,
  type WireRecordMetadata,
  type WireRecordRegisterOptions,
  type WireRecordRestoredContext,
  type WireRecordRestoreOptions,
  type WireRecordRestoreResult,
} from './wireRecord';

type Resumer<T extends keyof WireRecordMap> = (data: WireRecord<T>) => void | Promise<void>;
type BlobSelector<T extends keyof WireRecordMap> = WireRecordBlobSelector<WireRecord<T>>;

export class WireRecordService extends Disposable implements IWireRecord {
  declare readonly _serviceBrand: undefined;
  private readonly records: WireRecord[] = [];
  private readonly resumers = new Map<keyof WireRecordMap, Set<Resumer<keyof WireRecordMap>>>();
  private readonly blobSelectors = new Map<
    keyof WireRecordMap,
    BlobSelector<keyof WireRecordMap>[]
  >();
  private readonly persistKey: string | undefined;
  private persistentAppendQueue: Promise<void> = Promise.resolve();
  private _restoring: { time?: number } | null = null;
  private _postRestoring = false;
  private metadataInitialized = false;
  readonly hooks = {
    onRestoredRecord: new OrderedHookSlot<WireRecordRestoredContext>(),
    onResumeEnded: new OrderedHookSlot<{}>(),
  };

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IBlobStoreService private readonly blobStore?: IBlobStoreService,
    @IAppendLogStore private readonly log?: IAppendLogStore,
  ) {
    super();
    this.persistKey = hashKey(bootstrap.homeDir);
    if (this.log !== undefined && this.persistKey !== undefined) {
      this._register(this.log.acquire('wire', this.persistKey));
    }
  }

  get restoring() {
    return this._restoring;
  }

  get postRestoring() {
    return this._postRestoring;
  }

  append(record: WireRecord): void {
    if (this._restoring !== null) return;
    const stamped: WireRecord =
      record.time !== undefined ? record : ({ ...record, time: Date.now() } as WireRecord);
    this.records.push(stamped);
    this.appendPersistent(stamped);
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
      (this.log !== undefined && this.persistKey !== undefined
        ? this.log.read<PersistedWireRecord>('wire', this.persistKey)
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
      fromPersistence && this.log !== undefined && this.persistKey !== undefined;
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
        this.metadataInitialized = true;
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
        this.metadataInitialized = true;
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
      this.log !== undefined &&
      this.persistKey !== undefined
    ) {
      this.log.rewrite('wire', this.persistKey, restoredRecords);
      await this.log.flush();
    }
    if (completed) {
      await this.runResumeEndedHooks();
    }
    return warning === undefined ? {} : { warning };
  }

  async flush(): Promise<void> {
    await this.persistentAppendQueue;
    await this.log?.flush();
  }

  async close(): Promise<void> {
    await this.persistentAppendQueue;
    await this.log?.close();
  }

  private appendPersistent(record: PersistedWireRecord): void {
    if (this.log === undefined || this.persistKey === undefined) return;
    let metadata: WireRecordMetadata | undefined;
    if (!this.metadataInitialized && record.type !== 'metadata') {
      metadata = {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: Date.now(),
      };
      this.metadataInitialized = true;
    }
    if (record.type === 'metadata') {
      this.metadataInitialized = true;
    }

    const append = this.persistentAppendQueue.then(async () => {
      if (this.log === undefined || this.persistKey === undefined) return;
      if (metadata !== undefined) {
        this.log.append('wire', this.persistKey, metadata, {
          onError: (error) => this.reportPersistenceError(error, metadata),
        });
      }
      const prepared = await this.preparePersistentRecord(record);
      this.log.append('wire', this.persistKey, prepared, {
        onError: (error) => this.reportPersistenceError(error, prepared),
      });
    });
    this.persistentAppendQueue = append.catch((error: unknown) => {
      this.reportPersistenceError(error, record);
    });
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

  private reportPersistenceError(
    error: unknown,
    _record?: PersistedWireRecord,
  ): void {
    onUnexpectedError(error);
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

  private async preparePersistentRecord(record: PersistedWireRecord): Promise<PersistedWireRecord> {
    if (record.type === 'metadata') return record;
    if (!this.blobSelectors.has(record.type as keyof WireRecordMap)) return record;
    return this.offloadRecord(record as WireRecord);
  }

  private async offloadRecord<T extends keyof WireRecordMap>(
    record: WireRecord<T>,
  ): Promise<WireRecord<T>> {
    return this.applyBlobSelectors(record, 'offload');
  }

  private async rehydrateRecord<T extends keyof WireRecordMap>(
    record: WireRecord<T>,
  ): Promise<WireRecord<T>> {
    return this.applyBlobSelectors(record, 'rehydrate');
  }

  private async applyBlobSelectors<T extends keyof WireRecordMap>(
    record: WireRecord<T>,
    direction: 'offload' | 'rehydrate',
  ): Promise<WireRecord<T>> {
    const blobStore = this.blobStore;
    if (blobStore === undefined) return record;

    const selectors = this.blobSelectors.get(record.type);
    if (selectors === undefined) return record;

    let current = record;
    for (const selector of [...selectors] as BlobSelector<T>[]) {
      for (const target of selector(current)) {
        const parts =
          direction === 'offload'
            ? await blobStore.offloadParts(target.parts)
            : await blobStore.rehydrateParts(target.parts);
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
  IWireRecord,
  WireRecordService,
  InstantiationType.Delayed,
  'wireRecord',
);

function isWireRecordMetadata(record: PersistedWireRecord): record is WireRecordMetadata {
  return record.type === 'metadata' && typeof record['protocol_version'] === 'string';
}

function hashKey(homedir: string): string {
  return createHash('sha256').update(homedir).digest('hex').slice(0, 16);
}
