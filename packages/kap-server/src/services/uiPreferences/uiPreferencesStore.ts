import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import type { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/interface/atomicDocumentStore';
import { isStorageError, StorageErrors } from '@moonshot-ai/agent-core-v2/persistence/interface/storage';
import lockfile from 'proper-lockfile';

import { ErrorCode } from '../../protocol/error-codes';
import type { UiPreferenceOp } from '../../protocol/rest-ui-preferences';
import {
  applyUiPreferenceOps,
  EMPTY_UI_PREFERENCES,
  importUiPreferences,
  parseUiPreferencesDocument,
  UiPreferencesError,
  type UiPreferencesChanges,
  type UiPreferencesDocument,
} from './document';

export const UI_PREFERENCES_SCOPE = '';
export const UI_PREFERENCES_FILE_NAME = 'ui-preferences.json';

const CORRUPTED = Symbol('corrupted');

export interface UiPreferencesChangedEvent {
  readonly revision: number;
  readonly changed: UiPreferencesChanges;
  readonly client_id?: string;
}

export interface UiPreferencesSnapshot {
  readonly revision: number;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface UiPreferencesStoreOptions {
  readonly docs: IAtomicDocumentStore;
  readonly homeDir: string;
  readonly publish: (event: UiPreferencesChangedEvent) => void;
  readonly onRecovered?: (backupPath: string) => void;
}

export class UiPreferencesStore {
  private readonly dir: string;
  private readonly path: string;
  private readonly backupPath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: UiPreferencesStoreOptions) {
    this.dir = opts.homeDir;
    this.path = join(this.dir, UI_PREFERENCES_FILE_NAME);
    this.backupPath = `${this.path}.bak`;
  }

  read(): Promise<UiPreferencesSnapshot> {
    return this.serialized(async () => {
      const current = await this.readDocument();
      const document = current === CORRUPTED ? await this.locked(() => this.loadDocument()) : current;
      return { revision: document.revision, values: document.values };
    });
  }

  patch(ops: readonly UiPreferenceOp[], clientId?: string): Promise<{ revision: number; changed: UiPreferencesChanges }> {
    return this.write(clientId, (document) => applyUiPreferenceOps(document, ops));
  }

  import(
    values: Readonly<Record<string, unknown>>,
    clientId?: string,
  ): Promise<{ revision: number; imported: readonly string[]; skipped: readonly string[] }> {
    return this.write(clientId, (document) => importUiPreferences(document, values));
  }

  private write<T extends { document: UiPreferencesDocument; changed: UiPreferencesChanges }>(
    clientId: string | undefined,
    apply: (document: UiPreferencesDocument) => T,
  ): Promise<Omit<T, 'document' | 'changed'> & { revision: number; changed: UiPreferencesChanges }> {
    return this.serialized(async () => {
      const result = await this.locked(async () => {
        const before = await this.loadDocument();
        const applied = apply(before);
        if (applied.document !== before) {
          await this.opts.docs.set(UI_PREFERENCES_SCOPE, UI_PREFERENCES_FILE_NAME, applied.document);
        }
        return applied;
      });
      const { document, changed, ...rest } = result;
      if (Object.keys(changed).length > 0) {
        this.opts.publish(
          clientId === undefined
            ? { revision: document.revision, changed }
            : { revision: document.revision, changed, client_id: clientId },
        );
      }
      return { ...rest, revision: document.revision, changed };
    });
  }

  private async locked<T>(run: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      retries: { retries: 60, minTimeout: 25, maxTimeout: 250, randomize: true },
    });
    try {
      return await run();
    } finally {
      await release();
    }
  }

  private async loadDocument(): Promise<UiPreferencesDocument> {
    const document = await this.readDocument();
    if (document !== CORRUPTED) return document;
    try {
      await rename(this.path, this.backupPath);
    } catch (error) {
      throw new UiPreferencesError(
        ErrorCode.PERSISTENCE_FAILURE,
        `ui preferences file is corrupted and could not be moved to ${this.backupPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.opts.onRecovered?.(this.backupPath);
    return EMPTY_UI_PREFERENCES;
  }

  private async readDocument(): Promise<UiPreferencesDocument | typeof CORRUPTED> {
    let raw: unknown;
    try {
      raw = await this.opts.docs.get<unknown>(UI_PREFERENCES_SCOPE, UI_PREFERENCES_FILE_NAME);
    } catch (error) {
      if (isStorageError(error, StorageErrors.codes.STORAGE_DECODE_FAILED)) return CORRUPTED;
      throw error;
    }
    try {
      return parseUiPreferencesDocument(raw);
    } catch (error) {
      if (error instanceof UiPreferencesError) return CORRUPTED;
      throw error;
    }
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
