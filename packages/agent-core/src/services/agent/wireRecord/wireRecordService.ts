import { join } from 'pathe';

import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
  toDisposable,
} from '../../../di';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  applyWireMigrations,
  isNewerWireVersion,
  resolveWireMigrations,
  type WireMigration,
  type WireMigrationRecord,
} from './migration';
import {
  IBlobStoreService,
  type BlobStoreServiceOptions,
} from '../blobStore/blobStore';
import { BlobStoreService } from '../blobStore/blobStoreService';
import { OrderedHookSlot } from '../hooks';
import type { WireRecord, WireRecordMap } from '../types';
import {
  IWireRecord,
  type PersistedWireRecord,
  type WireRecordBlobSelector,
  type WireRecordMetadata,
  type WireRecordPersistence,
  type WireRecordRegisterOptions,
  type WireRecordRestoredContext,
  type WireRecordRestoreOptions,
  type WireRecordRestoreResult,
  type WireRecordServiceOptions,
} from './wireRecord';
import { FileSystemWireRecordPersistence } from './persistence';

type Resumer<T extends keyof WireRecordMap> = (data: WireRecord<T>) => void | Promise<void>;
type BlobSelector<T extends keyof WireRecordMap> = WireRecordBlobSelector<WireRecord<T>>;

export class WireRecordService extends Disposable implements IWireRecord {
  private readonly records: WireRecord[] = [];
  private readonly resumers = new Map<keyof WireRecordMap, Set<Resumer<keyof WireRecordMap>>>();
  private readonly blobSelectors = new Map<
    keyof WireRecordMap,
    BlobSelector<keyof WireRecordMap>[]
  >();
  private readonly persistence: WireRecordPersistence | undefined;
  private readonly blobStore: IBlobStoreService | undefined;
  private _restoring: { time?: number } | null = null;
  private _postRestoring = false;
  private metadataInitialized = false;
  readonly hooks = {
    onRestoredRecord: new OrderedHookSlot<WireRecordRestoredContext>(),
    onResumeEnded: new OrderedHookSlot<{}>(),
  };

  constructor(
    private readonly options: WireRecordServiceOptions = {},
    @IBlobStoreService injectedBlobStore?: IBlobStoreService,
  ) {
    super();
    this.blobStore = this.resolveBlobStore(options, injectedBlobStore);
    this.persistence =
      options.persistence ??
      (options.homedir === undefined
        ? undefined
        : new FileSystemWireRecordPersistence(join(options.homedir, 'wire.jsonl'), {
            beforeWrite: (record) => this.preparePersistentRecord(record),
            onError: (error) => {
              this.reportPersistenceError(error);
            },
          }));
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
    const source = records ?? this.persistence?.read();
    if (source === undefined) {
      await this.runResumeEndedHooks();
      return {};
    }

    const rewriteMigratedRecords =
      fromPersistence && (options.rewriteMigratedRecords ?? true);
    const restoredRecords: PersistedWireRecord[] | undefined =
      rewriteMigratedRecords ? [] : undefined;
    const requireMetadata = fromPersistence && this.persistence !== undefined;
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

    if (completed && shouldRewrite && restoredRecords !== undefined) {
      this.persistence?.rewrite(restoredRecords);
      await this.persistence?.flush();
    }
    if (completed) {
      await this.runResumeEndedHooks();
    }
    return warning === undefined ? {} : { warning };
  }

  async flush(): Promise<void> {
    await this.persistence?.flush();
  }

  async close(): Promise<void> {
    await this.persistence?.close();
  }

  private appendPersistent(record: PersistedWireRecord): void {
    if (this.persistence === undefined) return;
    if (!this.metadataInitialized && record.type !== 'metadata') {
      const metadata: WireRecordMetadata = {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: Date.now(),
      };
      try {
        this.persistence.append(metadata);
        this.metadataInitialized = true;
      } catch (error) {
        this.reportPersistenceError(error, metadata);
        // oxlint-disable-next-line typescript-eslint/only-throw-error
        throw error;
      }
    }
    if (record.type === 'metadata') {
      this.metadataInitialized = true;
    }
    try {
      this.persistence.append(record);
    } catch (error) {
      this.reportPersistenceError(error, record);
      // oxlint-disable-next-line typescript-eslint/only-throw-error
      throw error;
    }
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
    record?: PersistedWireRecord,
  ): void {
    this.options.onPersistenceError?.(error, record);
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

  private resolveBlobStore(
    options: WireRecordServiceOptions,
    injectedBlobStore: IBlobStoreService | undefined,
  ): IBlobStoreService | undefined {
    if (options.blobStore !== undefined) return options.blobStore;
    if (options.homedir === undefined) return injectedBlobStore;

    const blobOptions: BlobStoreServiceOptions = {
      blobsDir: join(options.homedir, 'blobs'),
    };
    return new BlobStoreService(blobOptions);
  }
}

async function* toAsyncIterable<T>(
  source: Iterable<T> | AsyncIterable<T>,
): AsyncIterable<T> {
  for await (const item of source) {
    yield item;
  }
}

registerSingleton(IWireRecord, new SyncDescriptor(WireRecordService, [{}], true));

function isWireRecordMetadata(record: PersistedWireRecord): record is WireRecordMetadata {
  return record.type === 'metadata' && typeof record['protocol_version'] === 'string';
}
