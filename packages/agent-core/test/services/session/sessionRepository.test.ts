import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { LocalKaos, type Kaos } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionMeta } from '../../../src/session';
import { SessionRepository } from '../../../src/services/session/sessionRepository';

let rootDir: string;
let homedir: string;
let kaos: Kaos;

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    title: 'New Session',
    isCustomTitle: false,
    agents: {},
    custom: {},
    ...overrides,
  };
}

function statePath(): string {
  return join(homedir, 'state.json');
}

beforeEach(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'kimi-session-repo-'));
  homedir = join(rootDir, 'session-home');
  kaos = await LocalKaos.create();
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('SessionRepository', () => {
  it('create: write then read returns the same SessionMeta', async () => {
    const repo = new SessionRepository(homedir, kaos);
    const meta = makeMeta({ title: 'hello' });
    await repo.write(meta);

    const read = await repo.read();
    expect(read).toEqual(meta);
  });

  it('get: read on a missing state.json throws (matches Session.readMetadata)', async () => {
    // `Session.readMetadata` calls `persistenceKaos.readText` directly, which
    // rejects when the file is absent; the repository preserves that behavior.
    const repo = new SessionRepository(homedir, kaos);
    await expect(repo.read()).rejects.toThrow();
  });

  it('update: two sequential writes; read returns the latest', async () => {
    const repo = new SessionRepository(homedir, kaos);
    await repo.write(makeMeta({ title: 'first' }));
    await repo.write(makeMeta({ title: 'second' }));

    const read = await repo.read();
    expect(read.title).toBe('second');
  });

  it('write creates the homedir when it does not exist yet', async () => {
    const nested = join(homedir, 'nested', 'dir');
    const repo = new SessionRepository(nested, kaos);
    const meta = makeMeta({ title: 'nested' });
    await repo.write(meta);

    const onDisk = JSON.parse(readFileSync(join(nested, 'state.json'), 'utf8')) as SessionMeta;
    expect(onDisk).toEqual(meta);
  });

  it('flush resolves only after pending writes land on disk', async () => {
    const repo = new SessionRepository(homedir, kaos);
    const meta = makeMeta({ title: 'flushed' });
    // Intentionally do NOT await the write; flush must still wait for it.
    void repo.write(meta);

    await repo.flush();

    const onDisk = JSON.parse(readFileSync(statePath(), 'utf8')) as SessionMeta;
    expect(onDisk).toEqual(meta);
  });

  it('serializes concurrent writes: final state.json equals the last submitted meta', async () => {
    const repo = new SessionRepository(homedir, kaos);
    const count = 8;
    const metas = Array.from({ length: count }, (_, i) =>
      makeMeta({ title: `write-${i}`, updatedAt: `2026-01-0${i + 1}T00:00:00.000Z` }),
    );

    // Fire every write without awaiting; the repository must order them by
    // submission order and drop none.
    await Promise.all(metas.map((meta) => repo.write(meta)));
    await repo.flush();

    const last = metas[count - 1]!;
    const onDisk = readFileSync(statePath(), 'utf8');
    expect(onDisk).toBe(JSON.stringify(last, null, 2));
    expect(JSON.parse(onDisk)).toEqual(last);
  });

  it('keeps the write chain alive after a rejected write', async () => {
    // The original `Session.writeMetadata` chains via `.then(write, write)` so a
    // failed write does not poison subsequent writes on the SAME repository. Pin
    // that behavior: make the homedir path a file so `mkdir` rejects, then clear
    // it and confirm a later write on the same instance still runs.
    const blocked = join(rootDir, 'blocked-home');
    writeFileSync(blocked, 'x');
    const repo = new SessionRepository(blocked, kaos);

    await expect(repo.write(makeMeta({ title: 'first' }))).rejects.toThrow();

    rmSync(blocked);
    await repo.write(makeMeta({ title: 'second' }));
    await repo.flush();

    await expect(repo.read()).resolves.toMatchObject({ title: 'second' });
  });
});
