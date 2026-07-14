/**
 * Scenario: append-log file persistence and agent wire migration rewrites.
 *
 * Resolves real append-log and wire-record services by interface over file or
 * in-memory storage. Controlled storage promises expose rewrite durability
 * without wall-clock waits. Run with `pnpm --filter @moonshot-ai/agent-core-v2
 * exec vitest run test/agent/wireRecord/persistence.test.ts`.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  AppendLogStore,
  AGENT_WIRE_PROTOCOL_VERSION,
  IFileSystemStorageService,
  IAppendLogStore,
  type PersistedWireRecord,
} from '#/index';
import {
  IAgentScopeContext,
  makeAgentScopeContext,
} from '#/agent/scopeContext/scopeContext';
import { IAgentWireRecordService } from '#/agent/wireRecord/wireRecord';
import { AgentWireRecordService } from '#/agent/wireRecord/wireRecordService';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

const cleanups: string[] = [];
const disposables: DisposableStore[] = [];
const SCOPE = 'wire-test';
const KEY = 'wire.jsonl';

afterEach(async () => {
  for (const store of disposables.splice(0)) {
    store.dispose();
  }
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  cleanups.push(dir);
  return dir;
}

async function readLines(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8');
  return raw.split('\n').filter((line) => line.length > 0);
}

function createAppendLogHarness(storage: IFileSystemStorageService): IAppendLogStore {
  const disposable = new DisposableStore();
  disposables.push(disposable);

  const ix = disposable.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  return ix.get(IAppendLogStore);
}

function createWireRecordHarness(log: IAppendLogStore): IAgentWireRecordService {
  const disposable = new DisposableStore();
  disposables.push(disposable);

  const ix = disposable.add(new TestInstantiationService());
  ix.stub(
    IAgentScopeContext,
    makeAgentScopeContext({ agentId: 'main', agentScope: SCOPE }),
  );
  ix.stub(IAppendLogStore, log);
  ix.set(IAgentWireRecordService, new SyncDescriptor(AgentWireRecordService));
  return ix.get(IAgentWireRecordService);
}

async function createFileAppendLogHarness(): Promise<{
  readonly dir: string;
  readonly log: IAppendLogStore;
}> {
  const dir = await makeDir('wire-jsonl-test');
  return {
    dir,
    log: createAppendLogHarness(new FileStorageService(dir)),
  };
}

async function collect<R>(log: IAppendLogStore, scope = SCOPE, key = KEY): Promise<R[]> {
  const records: R[] = [];
  for await (const record of log.read<R>(scope, key)) {
    records.push(record);
  }
  return records;
}

describe('AppendLogStore file persistence', () => {
  it('writes only the appended record', async () => {
    const { dir, log } = await createFileAppendLogHarness();

    log.append(SCOPE, KEY, {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'hello' }],
      origin: { kind: 'user' },
    });
    await log.close();

    const lines = await readLines(join(dir, SCOPE, KEY));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)['type']).toBe('turn.prompt');
  });

  it('appends to an existing file without injecting records', async () => {
    const dir = await makeDir('wire-jsonl-test');
    const first = createAppendLogHarness(new FileStorageService(dir));
    first.append(SCOPE, KEY, {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'one' }],
      origin: { kind: 'user' },
    });
    await first.close();

    const second = createAppendLogHarness(new FileStorageService(dir));
    second.append(SCOPE, KEY, {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'two' }],
      origin: { kind: 'user' },
    });
    await second.close();

    const lines = await readLines(join(dir, SCOPE, KEY));
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line)['type'])).toEqual([
      'turn.prompt',
      'turn.prompt',
    ]);
  });

  it('returns appended metadata records from read() output', async () => {
    const { log } = await createFileAppendLogHarness();
    log.append(SCOPE, KEY, {
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
      created_at: 1,
    });
    log.append(SCOPE, KEY, {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'hi' }],
      origin: { kind: 'user' },
    });
    await log.close();

    const records = await collect<PersistedWireRecord>(log);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    });
    expect(records[1]!.type).toBe('turn.prompt');
  });

  it('rewrites records from the beginning and then appends after them', async () => {
    const { dir, log } = await createFileAppendLogHarness();
    log.append(SCOPE, KEY, {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'old' }],
      origin: { kind: 'user' },
    });
    await log.flush();
    await log.rewrite(SCOPE, KEY, [
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'new' }],
        origin: { kind: 'user' },
      },
    ]);
    log.append(SCOPE, KEY, {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'later' }],
      origin: { kind: 'user' },
    });
    await log.flush();

    const lines = await readLines(join(dir, SCOPE, KEY));
    expect(lines.map((line) => JSON.parse(line)['type'])).toEqual([
      'metadata',
      'turn.prompt',
      'turn.prompt',
    ]);
    expect(JSON.parse(lines[1]!)['input'][0]['text']).toBe('new');
    expect(JSON.parse(lines[2]!)['input'][0]['text']).toBe('later');
  });

  it('rewrites already flushed records from the beginning', async () => {
    const { dir, log } = await createFileAppendLogHarness();
    log.append(SCOPE, KEY, {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'old' }],
      origin: { kind: 'user' },
    });
    await log.flush();

    await log.rewrite(SCOPE, KEY, [
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'new' }],
        origin: { kind: 'user' },
      },
    ]);
    await log.flush();

    const lines = await readLines(join(dir, SCOPE, KEY));
    expect(lines.map((line) => JSON.parse(line)['type'])).toEqual([
      'metadata',
      'turn.prompt',
    ]);
    expect(JSON.parse(lines[1]!)['input'][0]['text']).toBe('new');
  });

  it('flushes pending records on close', async () => {
    const { dir, log } = await createFileAppendLogHarness();

    log.append(SCOPE, KEY, {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'late' }],
      origin: { kind: 'user' },
    });
    await log.close();

    const lines = await readLines(join(dir, SCOPE, KEY));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)['type']).toBe('turn.prompt');
  });

  it('propagates write failures from flush', async () => {
    const dir = await makeDir('wire-jsonl-test');
    await mkdir(join(dir, SCOPE, KEY), { recursive: true });
    const log = createAppendLogHarness(new FileStorageService(dir));

    log.append(SCOPE, KEY, {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'first' }],
      origin: { kind: 'user' },
    });

    await expect(log.flush()).rejects.toBeInstanceOf(Error);
  });
});

describe('wire record append-log persistence', () => {
  it('can be backed by the same IAppendLogStore contract as file persistence', async () => {
    const storage = new InMemoryStorageService();
    const log = createAppendLogHarness(storage);

    log.append<PersistedWireRecord>(SCOPE, KEY, {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'one' }],
      origin: { kind: 'user' },
    });
    await log.flush();
    await log.rewrite<PersistedWireRecord>(SCOPE, KEY, [
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
    ]);

    expect(await collect<PersistedWireRecord>(log)).toEqual([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
    ]);
  });
});

describe('AgentWireRecordService migration rewrite', () => {
  async function seedLegacyLog(storage: InMemoryStorageService): Promise<IAppendLogStore> {
    const log = createAppendLogHarness(storage);
    log.append<PersistedWireRecord>(SCOPE, KEY, {
      type: 'metadata',
      protocol_version: '1.0',
      created_at: 1,
    });
    log.append<PersistedWireRecord>(SCOPE, KEY, {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'hi' }],
      origin: { kind: 'user' },
    });
    await log.flush();
    return log;
  }

  it('restore resolves only after the migration rewrite is durable', async () => {
    const storage = new InMemoryStorageService();
    const log = await seedLegacyLog(storage);
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      markWriteStarted();
      await writeGate;
      return originalWrite(...args);
    };

    const svc = createWireRecordHarness(log);
    let restored = false;
    const restorePromise = svc.restore().then(() => {
      restored = true;
    });
    await writeStarted;
    expect(restored).toBe(false);

    releaseWrite();
    await restorePromise;

    const records = await collect<PersistedWireRecord>(log);
    expect(records[0]).toMatchObject({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    });
  });

  it('restore propagates a migration rewrite failure', async () => {
    const storage = new InMemoryStorageService();
    const log = await seedLegacyLog(storage);
    storage.write = async () => {
      throw new Error('disk full');
    };

    const svc = createWireRecordHarness(log);

    await expect(svc.restore()).rejects.toThrow('disk full');
  });
});
