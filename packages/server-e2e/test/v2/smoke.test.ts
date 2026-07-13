/**
 * Smoke test for the v2 wire surface — boots `server-v2` in-process (port 0)
 * and exercises the typed `Klient` over HTTP (core/session/agent channels)
 * and WS (agent event stream).
 *
 * The test client is a pure wire client: server state is arranged through the
 * in-process `server.core` reference only where the RPC surface offers no way
 * (e.g. creating the main agent, server-v2 gap G10); session creation goes
 * through the legacy `/api/v1` REST surface, and every other assertion goes
 * through `Klient`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureMainAgent,
  IAgentRPCService,
  ISessionActivity,
  ISessionIndex,
  ISessionLifecycleService,
  ISessionMetadata,
  IWorkspaceRegistry,
} from '@moonshot-ai/agent-core-v2';
import { type RunningServer, startServer } from '@moonshot-ai/kap-server';
import { Klient } from '@moonshot-ai/klient';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpClient } from '../../src/http.js';

describe('Klient (server-v2 smoke)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let client: Klient | undefined;
  let v1: HttpClient | undefined;
  let wsOpened = false;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-sdk-smoke-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const token = server.authTokenService.getToken();
    client = new Klient({ url: baseUrl, token });
    v1 = new HttpClient({ baseUrl, apiPrefix: '/api/v1', token, fetchImpl: fetch });
    wsOpened = false;
  });

  afterEach(async () => {
    if (wsOpened) {
      client?.ws().close();
      wsOpened = false;
    }
    client = undefined;
    v1 = undefined;
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
    const session = await v1!.createSession({ metadata: { cwd } });
    return session.id;
  }

  async function createMainAgent(sessionId: string): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    await ensureMainAgent(session);
  }

  it('lists sessions (core)', async () => {
    await createSession(home as string);
    const page = await client!.core(ISessionIndex).list({ limit: 20 });
    expect(page.items.length).toBeGreaterThanOrEqual(1);
  });

  it('creates and reads a workspace (core)', async () => {
    const registry = client!.core(IWorkspaceRegistry);
    const created = await registry.createOrTouch(home as string);
    expect(created.root).toBe(home);

    const got = await registry.get(created.id);
    expect(got?.root).toBe(home);
  });

  it('reads, renames, and archives a session (session scope)', async () => {
    const sid = await createSession(home as string);
    const s = client!.session(sid);

    const before = await s.service(ISessionMetadata).read();
    expect(before.id).toBe(sid);

    await s.service(ISessionMetadata).setTitle('renamed');
    const after = await s.service(ISessionMetadata).read();
    expect(after.title).toBe('renamed');

    // `status()` is sync in the shared interface but async over the wire.
    const status = await Promise.resolve(s.service(ISessionActivity).status());
    expect(['idle', 'running', 'awaiting_approval', 'awaiting_question']).toContain(status);

    await s.service(ISessionLifecycleService).archive(sid);
  });

  it('submits a prompt and runs a shell command (agent scope)', async () => {
    const sid = await createSession(home as string);
    await createMainAgent(sid);
    const agent = client!.session(sid).agent('main').service(IAgentRPCService);

    const submitted = await agent.prompt({
      input: [{ type: 'text', text: 'hello' }],
    });
    expect(typeof submitted?.turn_id).toBe('number');

    const shell = await agent.runShellCommand({ command: 'printf hello' });
    expect(shell.stdout).toBe('hello');
    expect(shell.stderr).toBe('');
  });

  it('streams agent events over ws', async () => {
    const sid = await createSession(home as string);
    await createMainAgent(sid);

    const ws = client!.ws();
    wsOpened = true;
    const received: unknown[] = [];
    const sub = ws.session(sid).agent('main').listen('events', (e) => {
      received.push(e);
    });

    await client!.session(sid).agent('main').service(IAgentRPCService).prompt({
      input: [{ type: 'text', text: 'hi' }],
    });

    const deadline = Date.now() + 10_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    sub.dispose();
    expect(received.length).toBeGreaterThan(0);
  });
});
