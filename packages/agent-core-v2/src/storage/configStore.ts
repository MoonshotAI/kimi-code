/**
 * `IConfigStore` / `ConfigStore` — the typed atomic-document service.
 *
 * Sits on top of `IStorageService` and stores one typed JSON value per
 * `(scope, key)`, replaced atomically on every write. This is the `Config`
 * access pattern: `state.json`, `upcoming-goals.json`, per-id cron/background
 * records, etc.
 *
 * It is a DI service: domains inject `IConfigStore` and call `get/set` with
 * the scope they own — they do not construct stores themselves. JSON
 * (de)serialization and atomic replacement are centralized here so domains
 * do not reimplement them.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IStorageService } from './storageService';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface IConfigStore {
  readonly _serviceBrand: undefined;

  /** Read the value at `(scope, key)`, or `undefined` when absent. */
  get<T>(scope: string, key: string): Promise<T | undefined>;

  /** Atomically replace the value at `(scope, key)`. */
  set<T>(scope: string, key: string, value: T): Promise<void>;

  /** Delete `(scope, key)`. Missing keys are not an error. */
  delete(scope: string, key: string): Promise<void>;

  /** List the keys under `scope`, optionally filtered by `prefix`. */
  list(scope: string, prefix?: string): Promise<readonly string[]>;
}

export const IConfigStore: ServiceIdentifier<IConfigStore> =
  createDecorator<IConfigStore>('configStore');

export class ConfigStore implements IConfigStore {
  declare readonly _serviceBrand: undefined;

  constructor(@IStorageService private readonly storage: IStorageService) {}

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    const bytes = await this.storage.read(scope, key);
    return bytes === undefined ? undefined : (JSON.parse(textDecoder.decode(bytes)) as T);
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    await this.storage.write(scope, key, textEncoder.encode(JSON.stringify(value)), {
      atomic: true,
    });
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.storage.delete(scope, key);
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    return this.storage.list(scope, prefix);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IConfigStore,
  ConfigStore,
  InstantiationType.Delayed,
  'storage',
);
