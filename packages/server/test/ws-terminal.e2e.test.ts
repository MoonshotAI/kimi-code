import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncDescriptor, ITerminalService, TerminalService } from '@moonshot-ai/agent-core';
import type { Terminal } from '@moonshot-ai/protocol';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { IRestGateway, startServer, type RunningServer } from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';
import { rawDataToString } from '../src/ws/rawData';
import { FakeTerminalBackend } from './terminalTestBackend';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;
let backend: FakeTerminalBackend;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-ws-terminal-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-ws-terminal-home-'));
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
    wsGatewayOptions: { pingIntervalMs: 5_000, pongTimeoutMs: 5_000 },
    serviceOverrides: [
      fixedTokenAuth(),
      [ITerminalService, new SyncDescriptor(TerminalService, [{ backend }], false)],
    ],
  });
  return server;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  const app = r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
};
  });
  // Auto-attach the fixed bearer token so the M5.1 auth hook passes. A
  // caller-supplied `authorization` header wins, so explicit token tests keep
  // working; every other header (Range, content-type, …) is preserved.
  return {
    inject(req: unknown) {
      const q = req as { headers?: Record<string, string | string[] | undefined> };
      return app.inject({
        ...q,
        headers: { authorization: 'Bearer test-token', ...q.headers },
      });
    },
  };
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

async function createSession(r: RunningServer): Promise<string> {
  const cwd = join(tmpDir, 'workspace');
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

async function createTerminal(r: RunningServer, sid: string): Promise<Terminal> {
  const env = envelopeOf<Terminal>(
    (await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/terminals`,
      payload: {},
    })).json(),
  );
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create terminal failed: ${JSON.stringify(env)}`);
  }
  return env.data;
}

async function openSocket(r: RunningServer): Promise<{
  ws: WebSocket;
  received: Record<string, unknown>[];
}> {
  const received: Record<string, unknown>[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(r.address.replace('http://', 'ws://') + '/api/v1/ws', [
      'kimi-code.bearer.test-token',
    ]);
    sock.on('message', (data) => {
      received.push(JSON.parse(rawDataToString(data)) as Record<string, unknown>);
    });
    sock.once('open', () => resolve(sock));
    sock.once('error', reject);
  });
  await waitFor(received, (frame) => frame['type'] === 'server_hello');
  return { ws, received };
}

async function waitFor(
  received: Record<string, unknown>[],
  pred: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = received.find(pred);
    if (hit !== undefined) return hit;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `waitFor timed out; received: ${received
      .map((frame) => {
        const frameType = typeof frame['type'] === 'string' ? frame['type'] : '(unknown)';
        const frameId = typeof frame['id'] === 'string' ? frame['id'] : '';
        return `${frameType}:${frameId}`;
      })
      .join(', ')}`,
  );
}

describe('terminal WS controls', () => {
  it('attaches, replays output, forwards live output, input, resize, and close', async () => {
    const r = await bootServer();
    const sid = await createSession(r);
    const terminal = await createTerminal(r, sid);
    backend.processes[0]!.emitData('before attach');
    const { ws, received } = await openSocket(r);

    ws.send(JSON.stringify({
      type: 'terminal_attach',
      id: 'ta1',
      payload: { session_id: sid, terminal_id: terminal.id, since_seq: 0 },
    }));
    const attachAck = await waitFor(received, (frame) => frame['type'] === 'ack' && frame['id'] === 'ta1');
    expect(attachAck['code']).toBe(0);
    expect(attachAck['payload']).toEqual({ attached: true, replayed: 1 });
    const replayed = await waitFor(received, (frame) => frame['type'] === 'terminal_output');
    expect((replayed['payload'] as { data: string }).data).toBe('before attach');

    backend.processes[0]!.emitData('live output');
    const live = await waitFor(
      received,
      (frame) => frame['type'] === 'terminal_output' && (frame['payload'] as { data?: string }).data === 'live output',
    );
    expect(live['terminal_id']).toBe(terminal.id);

    ws.send(JSON.stringify({
      type: 'terminal_input',
      id: 'ti1',
      payload: { session_id: sid, terminal_id: terminal.id, data: 'pwd\r' },
    }));
    await waitFor(received, (frame) => frame['type'] === 'ack' && frame['id'] === 'ti1');
    expect(backend.processes[0]!.writes).toEqual(['pwd\r']);

    ws.send(JSON.stringify({
      type: 'terminal_resize',
      id: 'tr1',
      payload: { session_id: sid, terminal_id: terminal.id, cols: 120, rows: 32 },
    }));
    await waitFor(received, (frame) => frame['type'] === 'ack' && frame['id'] === 'tr1');
    expect(backend.processes[0]!.resizes).toEqual([{ cols: 120, rows: 32 }]);

    ws.send(JSON.stringify({
      type: 'terminal_close',
      id: 'tc1',
      payload: { session_id: sid, terminal_id: terminal.id },
    }));
    const closeAck = await waitFor(received, (frame) => frame['type'] === 'ack' && frame['id'] === 'tc1');
    expect(closeAck['payload']).toEqual({ closed: true });
    expect(backend.processes[0]!.killed).toBe(true);

    ws.close();
  });

  it('returns 40414 for unknown terminal controls', async () => {
    const r = await bootServer();
    const sid = await createSession(r);
    const { ws, received } = await openSocket(r);

    ws.send(JSON.stringify({
      type: 'terminal_attach',
      id: 'ta404',
      payload: { session_id: sid, terminal_id: 'term_missing' },
    }));
    const ack = await waitFor(received, (frame) => frame['type'] === 'ack' && frame['id'] === 'ta404');
    expect(ack['code']).toBe(40414);

    ws.close();
  });
});
