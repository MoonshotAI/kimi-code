/**
 * `GET /api/v1/sessions/{session_id}/snapshot` — session snapshot shape
 * (Rust-engine projection) and error mapping.
 *
 * Engine-only semantics: the handler projects a minimal snapshot from the
 * Rust engine session registry (`RustSessionService`). There is no v2 journal
 * / snapshot-reader chain anymore, so `as_of_seq` is always 0, `epoch` is
 * `'rust'`, and approvals/questions are always empty (they surface via the WS
 * event stream instead).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sessionSnapshotResponseSchema } from '../src/protocol/rest-snapshot';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

describe('GET /api/v1/sessions/:id/snapshot (engine projection)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-snapshot-test-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function snapshot(sid: string) {
    const res = await fetch(`${base}/api/v1/sessions/${sid}/snapshot`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number; data: unknown };
    expect(body.code).toBe(0);
    return sessionSnapshotResponseSchema.parse(body.data);
  }

  it('returns a well-formed snapshot for a fresh session', async () => {
    const sid = await createSession();
    const snap = await snapshot(sid);

    expect(snap.session.id).toBe(sid);
    // Engine projection: no durable journal → watermark 0 / constant epoch.
    expect(snap.as_of_seq).toBe(0);
    expect(snap.epoch).toBe('rust');
    expect(snap.messages.items).toEqual([]);
    expect(snap.in_flight_turn).toBeNull();
    expect(snap.pending_approvals).toEqual([]);
    expect(snap.pending_questions).toEqual([]);
  });

  it('returns 404 for an unknown session', async () => {
    const res = await fetch(`${base}/api/v1/sessions/sess_does_not_exist/snapshot`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(40401);
  });

  // Engine-only semantics: `RustSessionService` keeps sessions in an in-memory
  // registry. A session that existed before a server restart is not live in
  // this process, so the snapshot route 404s — there is no v2 disk journal to
  // rehydrate from. (Engine-side session persistence exists via `session/save`
  // + `session/load` RPC, but the web service does not wire a rehydration
  // path; if that changes, this test should be updated accordingly.)
  it('returns 404 for a cold (not live) session after restart', async () => {
    const sid = await createSession();

    await server!.close();
    server = undefined;
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;

    const res = await fetch(`${base}/api/v1/sessions/${sid}/snapshot`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(40401);
  });
});
