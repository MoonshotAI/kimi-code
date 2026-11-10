export interface KeyedResourceGeneration {
  readonly owner: string;
  readonly generation: string | number;
}

export interface KeyedResource {
  dispose(): void | Promise<void>;
  abort?(reason?: unknown): void;
}

export interface KeyedResourceLease<Resource> {
  readonly resource: Resource;
  release(): void;
}

interface ResourceEntry<Resource extends KeyedResource> {
  promise: Promise<Resource>;
  resource?: Resource;
  leases: number;
  draining: boolean;
  abortOnDrain: boolean;
  aborted: boolean;
  disposed: boolean;
  drainPromise?: Promise<void>;
  releaseDrain?: () => void;
}

export class KeyedResourceLeasePool<Key, Resource extends KeyedResource> {
  private readonly entries = new Map<Key, ResourceEntry<Resource>>();
  private withdrawn = false;
  private withdrawal?: Promise<void>;

  constructor(
    readonly identity: KeyedResourceGeneration,
    private readonly create: (key: Key) => Resource | Promise<Resource>,
  ) {}

  acquire(key: Key): Promise<KeyedResourceLease<Resource>> {
    if (this.withdrawn) return Promise.reject(this.unavailable());
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = this.createEntry(key);
      this.entries.set(key, entry);
    }
    if (entry.draining) return Promise.reject(this.unavailable());
    entry.leases += 1;
    return entry.promise.then(
      (resource) => {
        let active = true;
        return {
          resource,
          release: () => {
            if (!active) return;
            active = false;
            entry.leases -= 1;
            if (entry.leases === 0) entry.releaseDrain?.();
          },
        };
      },
      (error: unknown) => {
        entry.leases -= 1;
        if (entry.leases === 0) entry.releaseDrain?.();
        throw error;
      },
    );
  }

  has(key: Key): boolean {
    return this.entries.has(key);
  }

  disposeKey(key: Key, reason?: unknown, abort = false): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.resolve();
    this.entries.delete(key);
    return this.drain(entry, reason, abort);
  }

  withdraw(reason?: unknown): Promise<void> {
    if (this.withdrawal !== undefined) return this.withdrawal;
    this.withdrawn = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.withdrawal = Promise.all(entries.map((entry) => this.drain(entry, reason, false))).then(
      () => undefined,
    );
    return this.withdrawal;
  }

  private createEntry(key: Key): ResourceEntry<Resource> {
    const entry: ResourceEntry<Resource> = {
      promise: undefined as unknown as Promise<Resource>,
      leases: 0,
      draining: false,
      abortOnDrain: false,
      aborted: false,
      disposed: false,
    };
    entry.promise = Promise.resolve()
      .then(() => this.create(key))
      .then(
        (resource) => {
          entry.resource = resource;
          if (entry.abortOnDrain) this.abort(entry);
          return resource;
        },
        (error: unknown) => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          throw error;
        },
      );
    return entry;
  }

  private drain(entry: ResourceEntry<Resource>, reason?: unknown, abort = false): Promise<void> {
    entry.abortOnDrain ||= abort;
    entry.drainPromise ??= (async () => {
      entry.draining = true;
      try {
        await entry.promise;
      } catch {
        return;
      }
      if (entry.abortOnDrain) this.abort(entry, reason);
      if (entry.leases > 0) {
        await new Promise<void>((resolve) => {
          entry.releaseDrain = resolve;
        });
      }
      if (entry.disposed) return;
      entry.disposed = true;
      await entry.resource!.dispose();
    })();
    return entry.drainPromise;
  }

  private abort(entry: ResourceEntry<Resource>, reason?: unknown): void {
    if (entry.aborted || entry.resource?.abort === undefined) return;
    entry.aborted = true;
    try {
      entry.resource.abort(reason);
    } catch {}
  }

  private unavailable(): Error {
    return new Error(
      `resource generation ${this.identity.owner}:${String(this.identity.generation)} is withdrawn`,
    );
  }
}
