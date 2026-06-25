import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '@moonshot-ai/kaos';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { AgentKaos } from '#/kaos/agentKaos';
import { IKaosService, ISessionKaosService } from '#/kaos/kaos';
import { SessionKaosService } from '#/kaos/sessionKaosService';
import {
  IAgentRecords,
  ISessionMetaStore,
} from '#/records/records';
import {
  AgentRecords,
  SessionMetaStore,
  encodeWorkDirKey,
} from '#/records/recordsService';
import { registerLogServices } from '../log/stubs';

describe('encodeWorkDirKey', () => {
  it('is deterministic and path-sensitive', () => {
    const a = encodeWorkDirKey('/home/user/repo');
    const b = encodeWorkDirKey('/home/user/repo');
    const c = encodeWorkDirKey('/home/user/other');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('wd_')).toBe(true);
  });
});

describe('SessionMetaStore', () => {
  let dir: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'records-test-'));
    const base = await LocalKaos.create();
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.define(ISessionKaosService, SessionKaosService);
        reg.define(ISessionMetaStore, SessionMetaStore);
      },
    });
    const sessionKaos = ix.get(ISessionKaosService);
    sessionKaos.setToolKaos(base.withCwd(dir));
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('read returns {} when state.json is absent', async () => {
    const meta = ix.get(ISessionMetaStore);
    expect(await meta.read()).toEqual({});
  });

  it('write merges and persists; read round-trips', async () => {
    const meta = ix.get(ISessionMetaStore);
    await meta.write({ title: 'hello' });
    await meta.write({ count: 1 });

    // read() goes straight to disk, so even the same instance reflects the
    // persisted state (no in-memory cache to mask a failed flush).
    const fresh = ix.get(ISessionMetaStore);
    expect(await fresh.read()).toEqual({ title: 'hello', count: 1 });
  });
});

describe('AgentRecords', () => {
  let dir: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let records: IAgentRecords;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'records-test-'));
    const base = await LocalKaos.create();
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.define(ISessionKaosService, SessionKaosService);
        reg.define(IKaosService, AgentKaos);
        reg.define(IAgentRecords, AgentRecords);
      },
    });
    const sessionKaos = ix.get(ISessionKaosService);
    sessionKaos.setToolKaos(base.withCwd(dir));
    records = ix.get(IAgentRecords);
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('logRecord appends and replay yields records in order', async () => {
    await records.logRecord({ kind: 'a', payload: 1 });
    await records.logRecord({ kind: 'b', payload: 2 });

    const out = [];
    for await (const r of records.replay()) out.push(r);
    expect(out).toEqual([
      { kind: 'a', payload: 1 },
      { kind: 'b', payload: 2 },
    ]);
  });

  it('replay on empty store yields nothing', async () => {
    const out = [];
    for await (const r of records.replay()) out.push(r);
    expect(out).toEqual([]);
  });
});
