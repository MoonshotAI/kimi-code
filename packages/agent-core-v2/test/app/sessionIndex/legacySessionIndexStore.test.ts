/**
 * Scenario: legacy session-index bytes are projected through the private App
 * Store.
 * Responsibilities: enforce physical-line recovery and the schema trust boundary.
 * Wiring: flat DI with the production Store and an in-memory storage backend.
 * Run from packages/agent-core-v2:
 *   pnpm exec vitest run test/app/sessionIndex/legacySessionIndexStore.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ILegacySessionIndexStore } from '#/app/sessionIndex/legacySessionIndexStore';
import { LegacySessionIndexStoreService } from '#/app/sessionIndex/legacySessionIndexStoreService';
import {
  SESSION_INDEX_KEY,
  SESSION_INDEX_SCOPE,
  type SessionIndexLine,
} from '#/app/sessionIndex/legacySessionIndexPersistence';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

const textEncoder = new TextEncoder();

function entry(sessionId: string, workDir = `/tmp/${sessionId}`): SessionIndexLine {
  return {
    sessionId,
    sessionDir: `sessions/example/${sessionId}`,
    workDir,
  };
}

describe('LegacySessionIndexStoreService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let storage: InMemoryStorageService;

  beforeEach(() => {
    disposables = new DisposableStore();
    storage = new InMemoryStorageService();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, storage);
        reg.define(ILegacySessionIndexStore, LegacySessionIndexStoreService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  function store(): ILegacySessionIndexStore {
    return ix.get(ILegacySessionIndexStore);
  }

  async function seed(raw: string): Promise<void> {
    await storage.write(SESSION_INDEX_SCOPE, SESSION_INDEX_KEY, textEncoder.encode(raw));
  }

  it('recovers adjacent records with nested containers and escaped strings', async () => {
    const first = {
      ...entry('first', '/tmp/项目-}{-"quoted"-\\'),
      ignored: { nested: [{ value: 'still }{ inside a string' }] },
    };
    const second = entry('second');
    await seed(`${JSON.stringify(first)}${JSON.stringify(second)}`);

    await expect(store().readEntries()).resolves.toEqual([
      entry('first', '/tmp/项目-}{-"quoted"-\\'),
      second,
    ]);
  });

  it('stops at garbage or malformed JSON within each physical line', async () => {
    const first = entry('before-garbage');
    const second = entry('before-malformed');
    await seed(
      `${JSON.stringify(first)}garbage${JSON.stringify(entry('after-garbage'))}\n` +
        `${JSON.stringify(second)}{"sessionId":}${JSON.stringify(entry('after-malformed'))}`,
    );

    await expect(store().readEntries()).resolves.toEqual([first, second]);
  });

  it('continues at the next physical line after a truncated adjacent record', async () => {
    const first = entry('complete-prefix');
    const second = entry('next-line');
    await seed(
      `${JSON.stringify(first)}{"sessionId":"truncated\r\n${JSON.stringify(second)}\r\n`,
    );

    await expect(store().readEntries()).resolves.toEqual([first, second]);
  });

  it('skips complete schema-invalid containers and continues scanning', async () => {
    const first = entry('before-invalid-schema');
    const second = entry('after-invalid-schema');
    await seed(`${JSON.stringify(first)}{}[]${JSON.stringify(second)}`);

    await expect(store().readEntries()).resolves.toEqual([first, second]);
  });

  it('reaches the final record in a large concatenated physical line', async () => {
    const repeated = JSON.stringify(entry('repeated'));
    const final = entry('final');
    await seed(`${repeated.repeat(150_000)}${JSON.stringify(final)}`);

    const entries = await store().readEntries();
    expect(entries).toHaveLength(150_001);
    expect(entries.at(-1)).toEqual(final);
  });
});
