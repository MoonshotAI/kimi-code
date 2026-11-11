import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  drainQueryStoreDisposals as drainMiniDbQueryStoreDisposals,
  MiniDbQueryStore,
} from '#/persistence/backends/minidb/miniDbQueryStore';
import {
  drainQueryStoreDisposals as drainSqliteQueryStoreDisposals,
  SqliteQueryStore,
} from '#/persistence/backends/sqlite/sqliteQueryStore';
import {
  IQueryStore,
  type Checkpoint,
  type IndexDef,
  type WriteOp,
} from '#/persistence/interface/queryStore';

export async function drainQueryStoreDisposals(): Promise<void> {
  await Promise.all([drainSqliteQueryStoreDisposals(), drainMiniDbQueryStoreDisposals()]);
}

export class DualWriteQueryStore extends SqliteQueryStore {
  private readonly minidb: MiniDbQueryStore;
  private readonly dualWriteLog: ILogService;
  private dualWriteTail: Promise<void> = Promise.resolve();

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @ILogService log: ILogService,
  ) {
    super(bootstrap, log);
    this.minidb = new MiniDbQueryStore(bootstrap, log);
    this.dualWriteLog = log;
  }

  private serializeDualWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.dualWriteTail.then(operation);
    this.dualWriteTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeBackup(
    operation: string,
    expectedBackupEpoch: number,
    write: () => Promise<void>,
  ): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.dualWriteLog.error('minidb dual-write failed', {
        operation,
        expectedBackupEpoch,
        backupEpoch: this.minidb.storeEpoch(),
        error: String(error),
      });
      await this.resetAfterPeerRebuild();
      throw error;
    }
  }

  override async put<T>(
    collection: string,
    key: string,
    value: T,
    options?: { columns?: Record<string, number> },
  ): Promise<void> {
    return this.serializeDualWrite(async () => {
      const backupEpoch = this.minidb.storeEpoch();
      await super.put(collection, key, value, options);
      await this.writeBackup('put', backupEpoch, () =>
        this.minidb.put(collection, key, value, options),
      );
    });
  }

  override async batch(ops: readonly WriteOp[]): Promise<void> {
    return this.serializeDualWrite(async () => {
      const backupEpoch = this.minidb.storeEpoch();
      await super.batch(ops);
      await this.writeBackup('batch', backupEpoch, () => this.minidb.batch(ops));
    });
  }

  override async delete(collection: string, key: string): Promise<void> {
    return this.serializeDualWrite(async () => {
      const backupEpoch = this.minidb.storeEpoch();
      await super.delete(collection, key);
      await this.writeBackup('delete', backupEpoch, () => this.minidb.delete(collection, key));
    });
  }

  override async dropCollection(collection: string): Promise<void> {
    return this.serializeDualWrite(async () => {
      const backupEpoch = this.minidb.storeEpoch();
      await super.dropCollection(collection);
      await this.writeBackup('dropCollection', backupEpoch, () =>
        this.minidb.dropCollection(collection),
      );
    });
  }

  override async ensureIndex(collection: string, def: IndexDef): Promise<void> {
    return this.serializeDualWrite(async () => {
      const backupEpoch = this.minidb.storeEpoch();
      await super.ensureIndex(collection, def);
      await this.writeBackup('ensureIndex', backupEpoch, () =>
        this.minidb.ensureIndex(collection, def),
      );
    });
  }

  override async setCheckpoint(
    source: string,
    checkpoint: Checkpoint,
    expectedStoreEpoch?: number,
  ): Promise<void> {
    return this.serializeDualWrite(async () => {
      const backupEpoch = this.minidb.storeEpoch();
      await super.setCheckpoint(source, checkpoint, expectedStoreEpoch);
      await this.writeBackup('setCheckpoint', backupEpoch, () =>
        this.minidb.setCheckpoint(source, checkpoint, backupEpoch),
      );
    });
  }

  override async close(): Promise<void> {
    return this.serializeDualWrite(async () => {
      await Promise.all([super.close(), this.minidb.close()]);
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  IQueryStore,
  DualWriteQueryStore,
  ScopeActivation.OnScopeCreated,
  'storage',
);
