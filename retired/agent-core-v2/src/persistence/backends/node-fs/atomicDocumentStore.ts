/**
 * `JsonAtomicDocumentStore` — node-fs backend for `IAtomicDocumentStore`.
 *
 * JSON and TOML codec implementations plus the `AtomicDocumentStoreBase`,
 * `JsonAtomicDocumentStore`, and `TomlAtomicDocumentStore` classes. Reads and
 * writes bytes through `IFileSystemStorageService`. Bound at
 * App scope.
 */

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { InstantiationType } from '#/_base/di/extensions';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Event } from '#/_base/event';

import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';
import {
  IAtomicDocumentStore,
  IAtomicTomlDocumentStore,
  type DocumentCodec,
} from '#/persistence/interface/atomicDocumentStore';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const jsonDocumentCodec: DocumentCodec = {
  format: 'json',
  encode(value: unknown): Uint8Array {
    return textEncoder.encode(JSON.stringify(value));
  },
  decode(bytes: Uint8Array): unknown {
    return JSON.parse(textDecoder.decode(bytes));
  },
};

export const tomlDocumentCodec: DocumentCodec = {
  format: 'toml',
  encode(value: unknown): Uint8Array {
    return textEncoder.encode(`${stringifyToml(value as Record<string, unknown>)}\n`);
  },
  decode(bytes: Uint8Array): unknown {
    const text = textDecoder.decode(bytes);
    if (text.trim().length === 0) return {};
    return parseToml(text);
  },
};

class AtomicDocumentStoreBase implements IAtomicDocumentStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly storage: IFileSystemStorageService,
    private readonly codec: DocumentCodec,
  ) {}

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    const bytes = await this.storage.read(scope, key);
    if (bytes === undefined) return undefined;
    try {
      return this.codec.decode(bytes) as T;
    } catch (error) {
      throw new StorageError(
        StorageErrors.codes.STORAGE_DECODE_FAILED,
        `failed to decode ${scope}/${key} as ${this.codec.format}`,
        {
          details: { scope, key, format: this.codec.format },
          cause: error,
        },
      );
    }
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    await this.storage.write(scope, key, this.codec.encode(value), { atomic: true });
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.storage.delete(scope, key);
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    return this.storage.list(scope, prefix);
  }

  watch(scope: string, key: string): Event<void> {
    return this.storage.watch?.(scope, key) ?? (Event.None as Event<void>);
  }

  acquire(_scope: string, _key: string): IDisposable {
    return toDisposable(() => {});
  }
}

export class JsonAtomicDocumentStore extends AtomicDocumentStoreBase {
  constructor(@IFileSystemStorageService storage: IFileSystemStorageService) {
    super(storage, jsonDocumentCodec);
  }
}

export class TomlAtomicDocumentStore extends AtomicDocumentStoreBase {
  constructor(@IFileSystemStorageService storage: IFileSystemStorageService) {
    super(storage, tomlDocumentCodec);
  }
}

registerScopedService(
  LifecycleScope.App,
  IAtomicDocumentStore,
  JsonAtomicDocumentStore,
  InstantiationType.Eager,
  'storage',
);

registerScopedService(
  LifecycleScope.App,
  IAtomicTomlDocumentStore,
  TomlAtomicDocumentStore,
  InstantiationType.Eager,
  'storage',
);
