import { Disposable } from '#/_base/di/lifecycle';
import { AsyncEmitter, type Event, type IWaitUntil } from '#/_base/event';

import { deepEqual, diffRecords, isEmptyDiff, type RecordDiff } from './record-diff';

const NO_ABORT = new AbortController().signal;

export interface DefaultRecordChangedEvent {
  readonly id: string | undefined;
}

export class ConfigurationRecordStore<T> extends Disposable {
  private records: Readonly<Record<string, T>> = {};
  private defaultId: string | undefined;
  private hydrated = false;
  private resolveReady!: () => void;
  readonly ready: Promise<void> = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  private readonly _onDidChangeRecords = this._register(
    new AsyncEmitter<RecordDiff & IWaitUntil>(),
  );
  readonly onDidChangeRecords: Event<RecordDiff & IWaitUntil> = this._onDidChangeRecords.event;
  private readonly _onDidChangeDefaultId = this._register(
    new AsyncEmitter<DefaultRecordChangedEvent & IWaitUntil>(),
  );
  readonly onDidChangeDefaultId: Event<DefaultRecordChangedEvent & IWaitUntil> =
    this._onDidChangeDefaultId.event;

  constructor(
    private readonly clearDefaultOnDelete: boolean,
    private readonly onRecordsChanged: () => void = () => {},
    private readonly onDefaultChanged: () => void = () => {},
  ) {
    super();
  }

  get(id: string): T | undefined {
    return this.records[id];
  }

  list(): Readonly<Record<string, T>> {
    return this.records;
  }

  getDefaultId(): string | undefined {
    return this.defaultId;
  }

  load(records: Readonly<Record<string, T>>, defaultId: string | undefined): void {
    void this.applyRecords(records);
    void this.applyDefaultId(defaultId);
    if (!this.hydrated) {
      this.hydrated = true;
      this.resolveReady();
    }
  }

  async replace(records: Readonly<Record<string, T>>): Promise<void> {
    await this.ready;
    await this.applyRecords(records);
  }

  async set(id: string, record: T): Promise<void> {
    await this.ready;
    if (deepEqual(this.records[id], record)) return;
    await this.applyRecords({ ...this.records, [id]: record });
  }

  async delete(id: string): Promise<void> {
    await this.ready;
    if (!(id in this.records)) return;
    const { [id]: _removed, ...rest } = this.records;
    await this.applyRecords(rest);
    if (this.clearDefaultOnDelete && this.defaultId === id) {
      await this.applyDefaultId(undefined);
    }
  }

  async setDefaultId(id: string | undefined): Promise<void> {
    await this.ready;
    await this.applyDefaultId(id);
  }

  private async applyRecords(next: Readonly<Record<string, T>>): Promise<void> {
    const diff = diffRecords(this.records, next);
    if (isEmptyDiff(diff)) return;
    this.records = { ...next };
    this.onRecordsChanged();
    await this._onDidChangeRecords.fireAsync(diff, NO_ABORT);
  }

  private async applyDefaultId(id: string | undefined): Promise<void> {
    if (this.defaultId === id) return;
    this.defaultId = id;
    this.onDefaultChanged();
    await this._onDidChangeDefaultId.fireAsync({ id }, NO_ABORT);
  }
}
