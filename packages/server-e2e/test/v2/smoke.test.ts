/**
 * Smoke test for the v2 `ServerClient` — boots `server-v2` in-process (port 0)
 * and exercises the SDK over HTTP (core/session/agent RPC) and WS (events).
 *
 * The test client is a pure wire client: server state is arranged through the
 * in-process `server.core` reference only where the RPC surface offers no way
 * (e.g. creating the main agent, server-v2 gap G10); every assertion goes
 * through the SDK.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  ISessionLifecycleService,
} from '@moonshot-ai/agent-core-v2';
import { type RunningServer, startServer } from '@moonshot-ai/server-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ServerClient } from '../../src/v2/index.js';

describe('ServerClient (server-v2 smoke)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let client: ServerClient | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-sdk-smoke-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    client = new ServerClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: server.authTokenService.getToken(),
    });
  });

  afterEach(async () => {
    if (client) {
      await client.close();
      client = undefined;
    }
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
    const session = await client!.v1.createSession({ metadata: { cwd } });
    return session.id;
  }

  async function createMainAgent(sessionId: string): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    await session.accessor.get(IAgentLifecycleService).createMain();
  }

  it('lists sessions (core)', async () => {
    await createSession(home as string);
    const page = await client!.sessions.list({ page_size: 20 });
    expect(page.items.length).toBeGreaterThanOrEqual(1);
  });

  it('creates and reads a workspace (core)', async () => {
    const created = await client!.workspaces.createOrTouch(home as string);
    expect(created.root).toBe(home);

    const got = await client!.workspaces.get(created.id);
    expect(got.root).toBe(home);
  });

  it('reads, renames, and archives a session (session scope)', async () => {
    const sid = await createSession(home as string);
    const s = client!.session(sid);

    const before = await s.read();
    expect(before.id).toBe(sid);

    await s.setTitle('renamed');
    const after = await s.read();
    expect(after.title).toBe('renamed');

    const status = await s.status();
    expect(['idle', 'running', 'awaiting_approval', 'awaiting_question']).toContain(status);

    await s.archive();
  });

  it('submits a prompt and runs a shell command (agent scope)', async () => {
    const sid = await createSession(home as string);
    await createMainAgent(sid);
    const agent = client!.session(sid).agent('main');

    const submitted = await agent.prompts.submit({
      input: [{ type: 'text', text: 'hello' }],
    });
    expect(typeof submitted.turn_id).toBe('number');

    const shell = await agent.shell.run({ command: 'printf hello' });
    expect(shell.stdout).toBe('hello');
    expect(shell.stderr).toBe('');
  });

  it('streams agent events over ws', async () => {
    const sid = await createSession(home as string);
    await createMainAgent(sid);

    const events = await client!.connect();
    const received: unknown[] = [];
    const off = events.onAgentEvents(sid, 'main', (e) => {
      received.push(e);
    });

    await client!.session(sid).agent('main').prompts.submit({
      input: [{ type: 'text', text: 'hi' }],
    });

    const deadline = Date.now() + 10_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    off();
    expect(received.length).toBeGreaterThan(0);
  });
});
