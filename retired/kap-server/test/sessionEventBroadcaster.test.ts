/**
 * `SessionEventBroadcaster` — engine-only mode: rust-frame fan-out, session
 * activation, and the watermark / replay / snapshot surface.
 *
 * The Rust engine is the only engine (see
 * `src/transport/ws/v1/sessionEventBroadcaster.ts`): sessions are activated
 * with ephemeral in-memory state (journal `:memory:` — never written), engine
 * frames arrive via `broadcastRustFrame` as volatile envelopes that ride the
 * watermark without advancing it, and live transcript streaming is a no-op.
 * The v2 event-bus / lifecycle paths were removed, so these tests pin the
 * retained public surface in engine mode (`rustOnly`): `subscribe` /
 * `unsubscribe`, `getCursor`, `getSnapshotState`, `getBufferedSince`,
 * `addGlobalTarget` / `removeGlobalTarget`, and `broadcastRustFrame` fan-out.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type BroadcastTarget,
  SessionEventBroadcaster,
} from '../src/transport/ws/v1/sessionEventBroadcaster';
import type { EventEnvelope } from '../src/transport/ws/v1/sessionEventJournal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectingTarget(): { target: BroadcastTarget; envelopes: EventEnvelope[] } {
  const envelopes: EventEnvelope[] = [];
  return { target: { send: (e) => envelopes.push(e) }, envelopes };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionEventBroadcaster', () => {
  let dir: string;
  let bc: SessionEventBroadcaster;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-broadcaster-test-'));
    bc = new SessionEventBroadcaster({
      eventsDir: dir,
      // Engine mode (mirrors `start.ts`): subscriptions are served with
      // ephemeral in-memory session states; Rust frames arrive via
      // `broadcastRustFrame`.
      rustOnly: true,
      maxBufferSize: 3,
    });
  });

  afterEach(async () => {
    await bc.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('activates a session on first subscribe and returns true', async () => {
    const { target, envelopes } = collectingTarget();
    expect(await bc.subscribe('s1', target)).toBe(true);

    bc.broadcastRustFrame('s1', { type: 'agent.turn.started', agent_id: 'main', turn_id: 't1' });
    expect(envelopes).toHaveLength(1);
  });

  it('subscribe is idempotent for the same target', async () => {
    const { target, envelopes } = collectingTarget();
    expect(await bc.subscribe('s1', target)).toBe(true);
    expect(await bc.subscribe('s1', target)).toBe(true);

    bc.broadcastRustFrame('s1', { type: 'agent.turn.ended', agent_id: 'main' });
    expect(envelopes).toHaveLength(1); // still one subscription
  });

  it('getCursor returns the in-memory watermark and epoch after activation', async () => {
    await bc.subscribe('s1', collectingTarget().target);

    const cursor = await bc.getCursor('s1');
    expect(cursor.seq).toBe(0);
    expect(cursor.epoch).toMatch(/^ep_/);
  });

  it('getCursor activates a session lazily for any session id', async () => {
    // Engine mode has no JS-side session registry: any id gets an ephemeral
    // in-memory state on first touch, so a never-subscribed session still
    // answers with a real journal incarnation.
    const cursor = await bc.getCursor('s1');
    expect(cursor.seq).toBe(0);
    expect(cursor.epoch).toMatch(/^ep_/);
  });

  it('getSnapshotState returns the empty engine snapshot', async () => {
    await bc.subscribe('s1', collectingTarget().target);

    const snap = await bc.getSnapshotState('s1');
    expect(snap.seq).toBe(0);
    expect(snap.epoch).toMatch(/^ep_/);
    expect(snap.inFlightTurn).toBeNull();
    expect(snap.subagents).toEqual([]);
  });

  it('serves the empty replay sequence from the in-memory journal', async () => {
    await bc.subscribe('s1', collectingTarget().target);

    // Nothing journalable is ever dispatched in engine mode, so replay serves
    // the empty sequence at the current (zero) watermark.
    const result = await bc.getBufferedSince('s1', { seq: 0 });
    expect(result.resyncRequired).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.currentSeq).toBe(0);
    expect(result.epoch).toMatch(/^ep_/);
  });

  it('returns epoch_changed for a mismatched epoch', async () => {
    await bc.subscribe('s1', collectingTarget().target);

    const result = await bc.getBufferedSince('s1', { seq: 0, epoch: 'ep_wrong' });
    expect(result.resyncRequired).toBe('epoch_changed');
    expect(result.currentSeq).toBe(0);
  });

  it('returns epoch_changed for a cursor ahead of the watermark', async () => {
    await bc.subscribe('s1', collectingTarget().target);

    // A stale / foreign cursor (e.g. from a different epoch or a pre-journal
    // client) can never be vouched for.
    const result = await bc.getBufferedSince('s1', { seq: 5 });
    expect(result.resyncRequired).toBe('epoch_changed');
  });

  it('unsubscribe stops delivery to the target', async () => {
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    bc.unsubscribe('s1', target);
    bc.broadcastRustFrame('s1', { type: 'agent.turn.started', agent_id: 'main' });
    expect(envelopes).toHaveLength(0);
  });

  it('unsubscribe is idempotent and ignores unknown sessions/targets', async () => {
    const { target } = collectingTarget();
    expect(() => bc.unsubscribe('nope', target)).not.toThrow();

    await bc.subscribe('s1', target);
    expect(() => bc.unsubscribe('s1', collectingTarget().target)).not.toThrow();
    expect(() => bc.unsubscribe('s1', target)).not.toThrow();
  });

  it('keeps the transcript subscription shape while live streaming is a no-op', async () => {
    const { target, envelopes } = collectingTarget();

    // A graded subscribe joins the seeded / deferred bookkeeping, but no
    // transcript frames are ever sent — the engine owns the transcript store
    // and serves it over REST.
    expect(await bc.subscribe('s1', target, undefined, { '*': 'delta' })).toBe(true);
    await bc.flushTranscriptSeed('s1', target);

    // Detach per agent and wholesale; unknown sessions/targets stay no-ops.
    expect(() => bc.unsubscribeTranscript('nope', target)).not.toThrow();
    expect(() => bc.unsubscribeTranscript('s1', target, ['main'])).not.toThrow();

    // Rust frames still fan out to the subscribed target — nothing
    // transcript-shaped rides along.
    bc.broadcastRustFrame('s1', { type: 'assistant.delta', agent_id: 'main', delta: 'Hi' });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.type).toBe('event');
    expect(
      envelopes.every((e) => e.type !== 'transcript.reset' && e.type !== 'transcript.ops'),
    ).toBe(true);
  });

  it('close() stops further session activation', async () => {
    await bc.close();

    expect(await bc.subscribe('s1', collectingTarget().target)).toBe(false);
    const cursor = await bc.getCursor('s1');
    expect(cursor).toEqual({ seq: 0, epoch: '' });
  });

  describe('rust-engine frame fan-out', () => {
    it('fans out rust frames to session subscribers without advancing seq', async () => {
      const { target, envelopes } = collectingTarget();
      await bc.subscribe('s1', target);

      bc.broadcastRustFrame('s1', {
        type: 'agent.turn.started',
        agent_id: 'main',
        turn_id: 't1',
      });
      bc.broadcastRustFrame('s1', {
        type: 'assistant.delta',
        agent_id: 'main',
        delta: 'Hi',
      });

      expect(envelopes).toHaveLength(2);
      // Rust frames are volatile and stamped with the current watermark
      // (0 — engine sessions journal nothing) — never advancing seq.
      expect(envelopes[0]).toMatchObject({
        type: 'event',
        volatile: true,
        seq: 0,
        session_id: 's1',
        payload: { type: 'agent.turn.started', agent_id: 'main', turn_id: 't1' },
      });
      expect(envelopes[1]!.payload).toMatchObject({
        type: 'assistant.delta',
        agent_id: 'main',
        delta: 'Hi',
      });
      expect((await bc.getCursor('s1')).seq).toBe(0);
    });

    it('is a no-op for sessions with no subscribers', async () => {
      const { target, envelopes } = collectingTarget();
      await bc.subscribe('s1', target);

      bc.broadcastRustFrame('other', {
        type: 'agent.turn.started',
        agent_id: 'main',
      });
      expect(envelopes).toHaveLength(0);
    });

    it('reaches global targets even without a session subscription', async () => {
      const { target, envelopes } = collectingTarget();
      bc.addGlobalTarget(target);

      bc.broadcastRustFrame('s1', {
        type: 'agent.turn.ended',
        agent_id: 'main',
      });
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]!.session_id).toBe('s1');
      bc.removeGlobalTarget(target);
    });

    it('stamps every frame with the session watermark without advancing it', async () => {
      const { target, envelopes } = collectingTarget();
      await bc.subscribe('s1', target);

      // Engine sessions journal nothing, so the watermark stays at 0 — every
      // frame rides it (same seq, same epoch) and the cursor never moves.
      for (let i = 0; i < 3; i++) {
        bc.broadcastRustFrame('s1', {
          type: 'agent.turn.started',
          agent_id: 'main',
          turn_id: `t${i}`,
        });
      }
      expect(envelopes.every((e) => e.seq === 0)).toBe(true);
      expect(envelopes.every((e) => e.epoch === envelopes[0]!.epoch)).toBe(true);
      expect(envelopes[0]!.volatile).toBe(true);
      expect((await bc.getCursor('s1')).seq).toBe(0);
    });
  });
});
