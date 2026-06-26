import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '@moonshot-ai/kaos';

import type { ILogService, ILogger } from '#/log/log';

import { AgentKaos } from '#/kaos/agentKaos';
import { SessionKaosService } from '#/kaos/sessionKaosService';
import {
  AgentRecords,
  SessionMetaStore,
  encodeWorkDirKey,
} from '#/records/recordsService';

const noopLogger: ILogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLogger,
};
const noopLog: ILogService = {
  ...noopLogger,
  _serviceBrand: undefined,
  level: 'info',
  setLevel: () => {},
};

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
  let sessionKaos: SessionKaosService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'records-test-'));
    const base = await LocalKaos.create();
    sessionKaos = new SessionKaosService(noopLog);
    sessionKaos.setToolKaos(base.withCwd(dir));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('read returns {} when state.json is absent', async () => {
    const meta = new SessionMetaStore(sessionKaos, noopLog);
    expect(await meta.read()).toEqual({});
  });

  it('write merges and persists; read round-trips', async () => {
    const meta = new SessionMetaStore(sessionKaos, noopLog);
    await meta.write({ title: 'hello' });
    await meta.write({ count: 1 });

    const fresh = new SessionMetaStore(sessionKaos, noopLog);
    expect(await fresh.read()).toEqual({ title: 'hello', count: 1 });
  });
});

describe('AgentRecords', () => {
  let dir: string;
  let records: AgentRecords;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'records-test-'));
    const base = await LocalKaos.create();
    const sessionKaos = new SessionKaosService(noopLog);
    sessionKaos.setToolKaos(base.withCwd(dir));
    const agentKaos = new AgentKaos(sessionKaos);
    records = new AgentRecords(agentKaos, noopLog);
  });

  afterEach(async () => {
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
