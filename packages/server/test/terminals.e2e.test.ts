import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncDescriptor, ITerminalService, TerminalService } from '@moonshot-ai/agent-core';
import type { Terminal } from '@moonshot-ai/protocol';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IRestGateway, startServer, type RunningServer } from '../src';
import { FakeTerminalBackend } from './terminalTestBackend';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;
let backend: FakeTerminalBackend;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-terminals-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-terminals-home-'));
  backend = new FakeTerminalBackend();
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
  }
  server = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootServer(): Promise<RunningServer> {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    serviceOverrides: [
      [ITerminalService, new SyncDescriptor(TerminalService, [{ backend }], false)],
    ],
  });
  return server;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
    };
  });
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
    details?: unknown;
  };
}

async function createSession(r: RunningServer, cwd: string): Promise<string> {
  mkdirSync(cwd, { recursive: true });
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

describe('terminal REST routes', () => {
  it('creates terminals for multiple sessions using each session workspace cwd', async () => {
    const r = await bootServer();
    const rootA = join(tmpDir, 'workspace-a');
    const rootB = join(tmpDir, 'workspace-b');
    const sidA = await createSession(r, rootA);
    const sidB = await createSession(r, rootB);

    const termA = envelopeOf<Terminal>(
      (await appOf(r).inject({
        method: 'POST',
        url: `/api/v1/sessions/${sidA}/terminals`,
        payload: { cols: 100, rows: 30 },
      })).json(),
    ).data!;
    const termB = envelopeOf<Terminal>(
      (await appOf(r).inject({
        method: 'POST',
        url: `/api/v1/sessions/${sidB}/terminals`,
        payload: {},
      })).json(),
    ).data!;

    expect(termA.session_id).toBe(sidA);
    expect(termB.session_id).toBe(sidB);
    expect(backend.spawns.map((spawn) => spawn.cwd)).toEqual([
      realpathSync(rootA),
      realpathSync(rootB),
    ]);

    const listA = envelopeOf<{ items: Terminal[] }>(
      (await appOf(r).inject({
        method: 'GET',
        url: `/api/v1/sessions/${sidA}/terminals`,
      })).json(),
    ).data!;
    const listB = envelopeOf<{ items: Terminal[] }>(
      (await appOf(r).inject({
        method: 'GET',
        url: `/api/v1/sessions/${sidB}/terminals`,
      })).json(),
    ).data!;
    expect(listA.items.map((t) => t.id)).toEqual([termA.id]);
    expect(listB.items.map((t) => t.id)).toEqual([termB.id]);
  });

  it('gets and closes a terminal by session id', async () => {
    const r = await bootServer();
    const sid = await createSession(r, join(tmpDir, 'workspace-c'));
    const terminal = envelopeOf<Terminal>(
      (await appOf(r).inject({
        method: 'POST',
        url: `/api/v1/sessions/${sid}/terminals`,
        payload: {},
      })).json(),
    ).data!;

    const got = envelopeOf<Terminal>(
      (await appOf(r).inject({
        method: 'GET',
        url: `/api/v1/sessions/${sid}/terminals/${terminal.id}`,
      })).json(),
    ).data!;
    expect(got.id).toBe(terminal.id);

    const closed = envelopeOf<{ closed: true }>(
      (await appOf(r).inject({
        method: 'POST',
        url: `/api/v1/sessions/${sid}/terminals/${terminal.id}:close`,
        payload: {},
      })).json(),
    );
    expect(closed.code).toBe(0);
    expect(closed.data).toEqual({ closed: true });
    expect(backend.processes[0]!.killed).toBe(true);
  });

  it('maps terminal not found and cwd escape errors to protocol codes', async () => {
    const r = await bootServer();
    const sid = await createSession(r, join(tmpDir, 'workspace-d'));

    const missing = envelopeOf<unknown>(
      (await appOf(r).inject({
        method: 'GET',
        url: `/api/v1/sessions/${sid}/terminals/term_missing`,
      })).json(),
    );
    expect(missing.code).toBe(40414);

    const escaping = envelopeOf<unknown>(
      (await appOf(r).inject({
        method: 'POST',
        url: `/api/v1/sessions/${sid}/terminals`,
        payload: { cwd: '../outside' },
      })).json(),
    );
    expect(escaping.code).toBe(41304);
  });
});
