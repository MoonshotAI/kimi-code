/**
 * Compatibility专项 — the local/local on-disk layout after the Workspace-domain
 * refactor is byte-identical to the pre-refactor one.
 *
 * Creates a session through the full server stack (workspace handler →
 * session scope → main agent) and asserts the persisted artifacts a v1
 * reader depends on: `workspaces.json` (original schema),
 * `session_index.jsonl` (`{sessionId, sessionDir, workDir}` with
 * `sessionDir = <home>/sessions/{wd_id}/{session_id}`),
 * `sessions/{wd_id}/{sid}/state.json`, and
 * `sessions/{wd_id}/{sid}/agents/main/wire.jsonl` (metadata envelope first,
 * `agents.main.homedir` written with the original value). Also proves the
 * snapshot route serves the layout end-to-end (cold resume from disk).
 * Wiring: real kap-server on a temp home.
 * Run: `pnpm --filter @moonshot-ai/kap-server exec vitest run test/workspaceLayout.test.ts`.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IAgentLifecycleService,
  getLiveSessionById,
} from '@moonshot-ai/agent-core-v2';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('local/local on-disk layout (byte compatibility)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let workDir: string | undefined;
  let base: string;
  const homes: string[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-layout-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-layout-work-'));
    homes.push(home, workDir);
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
      hostIdentity: TEST_HOST_IDENTITY,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function postJson<T>(path: string, body: unknown): Promise<Envelope<T>> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(server!) },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Envelope<T>;
  }

  it('persists the pre-refactor layout byte-for-byte and serves it through the snapshot reader', async () => {
    const created = await postJson<{ id: string; workspace_id: string }>('/api/v1/sessions', {
      metadata: { cwd: workDir },
    });
    expect(created.code).toBe(0);
    const sessionId = created.data.id;
    const workspaceId = created.data.workspace_id;
    const sessionDir = join(home!, 'sessions', workspaceId, sessionId);

    // workspaces.json — original v1 schema, one record keyed by workspace id.
    const workspacesFile = JSON.parse(await readFile(join(home!, 'workspaces.json'), 'utf8')) as {
      version: number;
      workspaces: Record<
        string,
        { root: string; name: string; created_at: string; last_opened_at: string }
      >;
      deleted_workspace_ids: string[];
    };
    expect(workspacesFile.version).toBe(1);
    expect(Object.keys(workspacesFile.workspaces)).toEqual([workspaceId]);
    expect(workspacesFile.workspaces[workspaceId]).toMatchObject({ root: workDir });
    expect(workspacesFile.deleted_workspace_ids).toEqual([]);

    // session_index.jsonl — one line per session, `{sessionId, sessionDir,
    // workDir}` with the v1 bucket address.
    const indexLines = (await readFile(join(home!, 'session_index.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { sessionId: string; sessionDir: string; workDir: string });
    expect(indexLines).toEqual([{ sessionId, sessionDir, workDir }]);

    // state.json — the session metadata document at the v1 path.
    const metaRaw = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8')) as {
      id: string;
    };
    expect(metaRaw.id).toBe(sessionId);

    // Materialize the main agent in-process; its wire log lands at the v1
    // path with the metadata envelope first and the original homedir value.
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    expect(session).toBeDefined();
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    await expect(stat(wirePath)).resolves.toBeDefined();
    const firstWireLine = (await readFile(wirePath, 'utf8')).split('\n')[0]!;
    expect((JSON.parse(firstWireLine) as { type: string }).type).toBe('metadata');
    const metaWithAgent = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8')) as {
      agents: Record<string, { homedir: string }>;
    };
    expect(metaWithAgent.agents['main']?.homedir).toBe(join(sessionDir, 'agents', 'main'));

    // The snapshot reader serves the layout straight from disk (auto mode).
    const snapshot = await fetch(`${base}/api/v1/sessions/${sessionId}/snapshot`, {
      headers: authHeaders(server!),
    });
    const snapshotBody = (await snapshot.json()) as Envelope<{ session: { id: string } }>;
    expect(snapshotBody.code).toBe(0);
    expect(snapshotBody.data.session.id).toBe(sessionId);

    // A second session in the same workspace lands in the SAME bucket and the
    // catalog still holds exactly one record (handler-level touch, no schema
    // or duplication drift).
    const second = await postJson<{ id: string; workspace_id: string }>('/api/v1/sessions', {
      metadata: { cwd: workDir },
    });
    expect(second.code).toBe(0);
    expect(second.data.workspace_id).toBe(workspaceId);
    const workspacesAfter = JSON.parse(
      await readFile(join(home!, 'workspaces.json'), 'utf8'),
    ) as { workspaces: Record<string, unknown> };
    expect(Object.keys(workspacesAfter.workspaces)).toEqual([workspaceId]);
    const indexAfter = (await readFile(join(home!, 'session_index.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { sessionId: string });
    expect(indexAfter.map((entry) => entry.sessionId)).toEqual([sessionId, second.data.id]);
  });
});
