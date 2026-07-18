/**
 * Smoke test for the v2 wire surface — boots `server-v2` in-process (port 0).
 *
 * The global (app-scope) assertions go through the klient facade
 * (`@moonshot-ai/klient/http`). Session/agent assertions call the `/api/v2`
 * wire directly (fetch + raw WS frames) — TODO: move them to the klient
 * session/agent facades when those land.
 *
 * Server state is arranged through the in-process `server.core` reference only
 * where the RPC surface offers no way (creating the main agent, server-v2 gap
 * G10); session creation goes through the legacy `/api/v1` REST surface.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureMainAgent, ISessionLifecycleService } from '@moonshot-ai/agent-core-v2';
import { type RunningServer, startServer } from '@moonshot-ai/kap-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKlient } from '../../../src/transports/http/index.js';
import type { Klient } from '../../../src/index.js';

/** Direct `/api/v2` wire call (see TODO above). */
async function v2Rpc<T>(
  baseUrl: string,
  token: string,
  path: string,
  args: unknown[],
): Promise<T> {
  const res = await fetch(`${baseUrl}/api/v2${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const envelope = (await res.json()) as { code: number; msg: string; data: T };
  if (envelope.code !== 0) {
    throw new Error(`v2 ${path} failed: ${envelope.code} ${envelope.msg}`);
  }
  return envelope.data;
}

/** Session creation goes through the legacy `/api/v1` REST surface. */
async function v1CreateSession(baseUrl: string, token: string, cwd: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ metadata: { cwd } }),
  });
  const envelope = (await res.json()) as { code: number; msg: string; data: { id: string } };
  if (envelope.code !== 0) {
    throw new Error(`v1 createSession failed: ${envelope.code} ${envelope.msg}`);
  }
  return envelope.data.id;
}

describe('Klient (server-v2 smoke)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let klient: Klient | undefined;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-sdk-smoke-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    baseUrl = `http://127.0.0.1:${server.port}`;
    token = server.authTokenService.getToken();
    klient = createKlient({ url: baseUrl, token });
  });

  afterEach(async () => {
    await klient?.close();
    klient = undefined;
    if (server) {
      await server.close();
      server = undefined;
    }
    if (home) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function createSession(cwd: string): Promise<string> {
    return v1CreateSession(baseUrl, token, cwd);
  }

  async function createMainAgent(sessionId: string): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    await ensureMainAgent(session);
  }

  it('lists sessions (global facade)', async () => {
    await createSession(home as string);
    const page = await klient!.global.sessions.list({ limit: 20 });
    expect(page.items.length).toBeGreaterThanOrEqual(1);
  });

  it('creates and reads a workspace (global facade)', async () => {
    const workspaces = klient!.global.workspaces;
    const created = await workspaces.createOrTouch({ root: home as string });
    expect(created.root).toBe(home);

    const got = await workspaces.get(created.id);
    expect(got?.root).toBe(home);
  });

  it('reads, renames, and archives a session (session scope, direct wire)', async () => {
    const sid = await createSession(home as string);

    const before = await v2Rpc<{ id: string; title?: string }>(
      baseUrl,
      token,
      `/session/${sid}/sessionMetadata/read`,
      [],
    );
    expect(before.id).toBe(sid);

    await v2Rpc(baseUrl, token, `/session/${sid}/sessionMetadata/setTitle`, ['renamed']);
    const after = await v2Rpc<{ title?: string }>(
      baseUrl,
      token,
      `/session/${sid}/sessionMetadata/read`,
      [],
    );
    expect(after.title).toBe('renamed');

    const pending = await v2Rpc<unknown[]>(
      baseUrl,
      token,
      `/session/${sid}/sessionInteractionService/listPending`,
      [],
    );
    expect(pending).toEqual([]);

    await v2Rpc(baseUrl, token, `/session/${sid}/sessionLifecycleService/archive`, [sid]);
  });

  it('submits a prompt and runs a shell command (agent scope, direct wire)', async () => {
    const sid = await createSession(home as string);
    await createMainAgent(sid);

    const submitted = await v2Rpc<{ turn_id?: number } | undefined>(
      baseUrl,
      token,
      `/session/${sid}/agent/main/agentRPCService/prompt`,
      [{ input: [{ type: 'text', text: 'hello' }] }],
    );
    expect(typeof submitted?.turn_id).toBe('number');

    const shell = await v2Rpc<{ stdout: string; stderr: string }>(
      baseUrl,
      token,
      `/session/${sid}/agent/main/agentRPCService/runShellCommand`,
      [{ command: 'printf hello' }],
    );
    expect(shell.stdout).toBe('hello');
    expect(shell.stderr).toBe('');
  });

  it('streams agent events over ws (raw frames)', async () => {
    const sid = await createSession(home as string);
    await createMainAgent(sid);

    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/v2/ws`;
    const ws = new WebSocket(wsUrl, [`kimi-code.bearer.${token}`]);
    const received: unknown[] = [];
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; data?: unknown };
      if (frame.type === 'event') received.push(frame.data);
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        resolve();
      };
      ws.onerror = () => {
        reject(new Error('ws connect failed'));
      };
    });
    ws.send(JSON.stringify({ type: 'hello', token }));
    ws.send(
      JSON.stringify({
        type: 'listen',
        id: 'l1',
        scope: 'agent',
        sessionId: sid,
        agentId: 'main',
        event: 'events',
      }),
    );

    await v2Rpc(baseUrl, token, `/session/${sid}/agent/main/agentRPCService/prompt`, [
      { input: [{ type: 'text', text: 'hi' }] },
    ]);

    const deadline = Date.now() + 10_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    ws.close();
    expect(received.length).toBeGreaterThan(0);
  });
});
