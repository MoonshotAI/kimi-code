#!/usr/bin/env node
/**
 * Scenario 04 — session runtime controls (stateful session + diff dispatch).
 *
 * Verifies two contracts:
 *
 * **Per-turn override path**: each `POST /v1/sessions/{sid}/prompts` body
 * MAY carry any subset of `model`, `thinking`, `permission_mode`,
 * `plan_mode`. The services layer ONLY calls the matching `core.rpc.*`
 * setter when the field actually changes — and tags each dispatch
 * `source='prompt'` so debug observers can attribute it.
 *
 * **Stateful session / /profile path**: `POST /v1/sessions/{sid}/profile` with
 * `{agent_config: {...}}` mutates the same shadow through
 * `IPromptService.applyAgentState`, tagged `source='meta'`. A subsequent
 * content-only `POST /prompts` (no overrides) inherits the shadow and
 * issues ZERO setter dispatches.
 *
 * The old version of this scenario only watched `agent.status.updated`
 * frames — but a no-op submit and a redundant re-dispatch produce the same
 * WS surface, so "shadow held" couldn't be proven. This version asserts
 * directly against the server's `/debug` endpoints:
 *
 *   GET /api/v1/debug/prompts/{sid}/state         -> shadow snapshot
 *   GET /api/v1/debug/prompts/{sid}/dispatch-log  -> ring buffer
 *
 * The server must be launched with `--debug-endpoints` (or
 * `startServer({debugEndpoints: true})`) for those routes to exist.
 *
 * Wire sequence:
 *   1. Submit with default controls. Capture the dispatch-log baseline:
 *      this may be 0, or it may include setter calls if the server's
 *      config.toml defaults differ from the scenario's default body. Either
 *      is correct — what matters is the deltas between phases.
 *   2. Submit with `plan_mode: true`. Expect EXACTLY 1 new entry of
 *      kind `enterPlan` tagged `source='prompt'`. Shadow.planMode must
 *      now be `true`.
 *   3. Submit with `plan_mode: true` again. Expect ZERO new entries
 *      (this is the key property — shadow suppresses re-dispatch).
 *   4. Submit with `plan_mode: false` + `permission_mode: 'yolo'`.
 *      Expect EXACTLY 2 new entries in `_applyAgentState` order
 *      (permission before plan): `[setPermission, cancelPlan]`.
 *   5. POST `/sessions/{sid}/profile` with `{agent_config: {permission_mode:
 *      'manual'}}` → expect +1 dispatch tagged `source='meta'`. Then a
 *      content-only `POST /prompts` → expect +0 dispatches.
 *
 * Usage:
 *   KIMI_SERVER_URL=http://127.0.0.1:58627 npx tsx scenarios/04-stateless-controls.ts
 *
 * Exit codes:
 *   0  — pass
 *   1  — assertion failure or server error
 */
import assert from 'node:assert/strict';

import { DaemonClient } from '../src/index';
import { fetchWithReport } from '../src/report';

const KIMI_SERVER_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const API_PREFIX = '/api/v1';
const PROMPT_TIMEOUT_MS = 60_000;

interface Envelope<T> {
  code: number;
  msg?: string;
  data: T | null;
}

interface DebugState {
  planMode: boolean;
  permissionMode: string;
  [key: string]: unknown;
}

interface DispatchEntry {
  kind: string;
  source: string;
  promptId: string;
  [key: string]: unknown;
}

/**
 * Fetch the debug shadow snapshot for `sid`. Returns `null` when the
 * session has not yet bootstrapped (i.e. no submit has run). Throws a
 * descriptive error when `/debug/*` isn't mounted (server launched
 * without `--debug-endpoints`).
 */
async function fetchDebugState(sid: string): Promise<DebugState | null> {
  const url = `${KIMI_SERVER_URL}${API_PREFIX}/debug/prompts/${encodeURIComponent(sid)}/state`;
  const res = await fetchWithReport(url);
  if (res.status === 404) {
    throw new Error(
      `GET ${url} -> 404. Did you start the server with --debug-endpoints?`,
    );
  }
  const env = (await res.json()) as Envelope<DebugState>;
  if (env.code !== 0) {
    throw new Error(`GET ${url} -> code=${env.code} msg=${env.msg ?? ''}`);
  }
  return env.data ?? null;
}

/** Fetch the dispatch-log entries (newest-last). */
async function fetchDispatchLog(sid: string): Promise<DispatchEntry[]> {
  const url = `${KIMI_SERVER_URL}${API_PREFIX}/debug/prompts/${encodeURIComponent(sid)}/dispatch-log`;
  const res = await fetchWithReport(url);
  if (res.status === 404) {
    throw new Error(
      `GET ${url} -> 404. Did you start the server with --debug-endpoints?`,
    );
  }
  const env = (await res.json()) as Envelope<{ entries: DispatchEntry[] }>;
  if (env.code !== 0) {
    throw new Error(`GET ${url} -> code=${env.code} msg=${env.msg ?? ''}`);
  }
  return (env.data && Array.isArray(env.data.entries)) ? env.data.entries : [];
}

async function main() {
  const client = new DaemonClient({ baseUrl: KIMI_SERVER_URL });

  let sid: string | undefined;
  try {
    const session = await client.createSession({ metadata: { cwd: process.cwd() } });
    sid = session.id;
    console.log(`▶ session ${sid} created`);

    await client.connect();
    await client.subscribe(sid);

    // ── Phase 1 — defaults, baseline ──────────────────────────────────────
    // We don't know whether the server's config.toml defaults match the
    // scenario's defaults — they often don't, so this submit may legally
    // emit `setModel` / `setThinking` / `setPermission` against bootstrap.
    // Capture the resulting state + dispatch-log baseline; later phases
    // assert ONLY on deltas.
    await client.submitAndWait(
      sid,
      { content: [{ type: 'text', text: 'Reply with the single word "OK".' }] },
      { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
    );
    let logAfterPhase1: DispatchEntry[] = [];
    {
      const state = await fetchDebugState(sid);
      logAfterPhase1 = await fetchDispatchLog(sid);
      assert.ok(state !== null, 'phase 1: shadow should be bootstrapped after first submit');
      // After phase 1 the shadow reflects the body we sent (defaults), so
      // permission/plan are pinned regardless of what the server's config
      // started at — any divergent setters fired here landed in the log.
      assert.equal(state.planMode, false, `phase 1: shadow.planMode=${state.planMode}, want false`);
      assert.equal(state.permissionMode, 'manual', `phase 1: shadow.permissionMode=${state.permissionMode}, want manual`);
      console.log(`▶ phase 1: defaults submitted — shadow=${JSON.stringify(state)} log.length=${logAfterPhase1.length} (baseline)`);
    }

    // ── Phase 2 — turn plan_mode on ───────────────────────────────────────
    // Only `plan_mode` differs from the phase-1 shadow. Expect EXACTLY one
    // new dispatch entry of kind `enterPlan` tagged source='prompt'.
    await client.submitAndWait(
      sid,
      {
        content: [{ type: 'text', text: 'Reply with the single word "OK".' }],
        plan_mode: true,
      },
      { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
    );
    let logAfterPhase2: DispatchEntry[] = [];
    {
      const state = await fetchDebugState(sid);
      logAfterPhase2 = await fetchDispatchLog(sid);
      assert.ok(state !== null, 'phase 2: shadow should be bootstrapped');
      assert.equal(state.planMode, true, `phase 2: shadow.planMode=${state.planMode}, want true`);
      const newEntries = logAfterPhase2.slice(logAfterPhase1.length);
      assert.equal(newEntries.length, 1, `phase 2: expected +1 dispatch, got +${newEntries.length}: ${JSON.stringify(newEntries)}`);
      const entry = newEntries[0];
      assert.ok(entry, 'phase 2: expected dispatch entry');
      assert.equal(entry.kind, 'enterPlan', `phase 2: expected enterPlan, got ${entry.kind}`);
      assert.equal(entry.source, 'prompt', `phase 2: expected source='prompt', got ${entry.source}`);
      console.log(`▶ phase 2: plan_mode=true — +1 enterPlan dispatched (source='prompt') ✓`);
    }

    // ── Phase 3 — repeat plan_mode: true (THE KEY ASSERTION) ──────────────
    // Same body. The shadow says planMode is already true, so
    // `_applyAgentState` must skip the dispatch entirely. Dispatch-log length
    // MUST be unchanged. This is the property the old WS-only scenario
    // could not prove.
    await client.submitAndWait(
      sid,
      {
        content: [{ type: 'text', text: 'Reply with the single word "OK".' }],
        plan_mode: true,
      },
      { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
    );
    {
      const state = await fetchDebugState(sid);
      const log = await fetchDispatchLog(sid);
      assert.ok(state !== null, 'phase 3: shadow should be bootstrapped');
      assert.equal(state.planMode, true, `phase 3: shadow.planMode=${state.planMode}, want true (held)`);
      assert.equal(
        log.length,
        logAfterPhase2.length,
        `phase 3: dispatch-log MUST NOT grow on a redundant submit; was ${logAfterPhase2.length}, now ${log.length}. New entries: ${JSON.stringify(log.slice(logAfterPhase2.length))}`,
      );
      console.log(`▶ phase 3: repeat plan_mode=true — shadow held, +0 dispatches ✓`);
    }

    // ── Phase 4 — plan off + permission yolo ──────────────────────────────
    // Two diffs vs the phase-3 shadow: `permission_mode` manual→yolo and
    // `plan_mode` true→false. `_applyAgentState` order is model → thinking
    // → permission → plan, so we expect entries `[setPermission, cancelPlan]`.
    await client.submitAndWait(
      sid,
      {
        content: [{ type: 'text', text: 'Reply with the single word "OK".' }],
        plan_mode: false,
        permission_mode: 'yolo',
      },
      { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
    );
    {
      const state = await fetchDebugState(sid);
      const log = await fetchDispatchLog(sid);
      assert.ok(state !== null, 'phase 4: shadow should be bootstrapped');
      assert.equal(state.planMode, false, `phase 4: shadow.planMode=${state.planMode}, want false`);
      assert.equal(state.permissionMode, 'yolo', `phase 4: shadow.permissionMode=${state.permissionMode}, want yolo`);
      const newEntries = log.slice(logAfterPhase2.length);
      assert.equal(newEntries.length, 2, `phase 4: expected +2 new entries, got +${newEntries.length}: ${JSON.stringify(newEntries)}`);
      assert.deepEqual(
        newEntries.map((e) => e.kind),
        ['setPermission', 'cancelPlan'],
        `phase 4: expected [setPermission, cancelPlan], got ${JSON.stringify(newEntries.map((e) => e.kind))}`,
      );
      console.log(`▶ phase 4: plan cancel + yolo — +2 dispatches in order [setPermission, cancelPlan] ✓`);
    }
    let logAfterPhase4: DispatchEntry[] = [];
    {
      logAfterPhase4 = await fetchDispatchLog(sid);
    }

    // ── Phase 5 — POST /profile drives the shadow (source='meta') ──────────
    // Flip `permission_mode` back to `manual` via /profile. The shared
    // applyAgentState helper diff-dispatches a single `setPermission` and
    // records source='meta'. A subsequent CONTENT-ONLY prompt then inherits
    // the shadow and triggers ZERO additional setters — the proof that
    // the session is genuinely stateful.
    await client.updateSession(sid, {
      agent_config: { permission_mode: 'manual' },
    });
    {
      const state = await fetchDebugState(sid);
      const log = await fetchDispatchLog(sid);
      assert.ok(state !== null, 'phase 5a: shadow should be bootstrapped');
      assert.equal(state.permissionMode, 'manual', `phase 5a: shadow.permissionMode=${state.permissionMode}, want manual`);
      const newEntries = log.slice(logAfterPhase4.length);
      assert.equal(newEntries.length, 1, `phase 5a: expected +1 dispatch from /profile, got +${newEntries.length}: ${JSON.stringify(newEntries)}`);
      const entry = newEntries[0];
      assert.ok(entry, 'phase 5a: expected dispatch entry');
      assert.equal(entry.kind, 'setPermission', `phase 5a: expected setPermission, got ${entry.kind}`);
      assert.equal(entry.source, 'meta', `phase 5a: expected source='meta', got ${entry.source}`);
      assert.equal(entry.promptId, '', `phase 5a: /profile dispatch carries empty promptId, got ${JSON.stringify(entry.promptId)}`);
      console.log(`▶ phase 5a: POST /profile permission=manual — +1 setPermission dispatched (source='meta') ✓`);
    }
    const logAfterPhase5a = await fetchDispatchLog(sid);
    await client.submitAndWaitStateful(
      sid,
      { content: [{ type: 'text', text: 'Reply with the single word "OK".' }] },
      { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
    );
    {
      const state = await fetchDebugState(sid);
      const log = await fetchDispatchLog(sid);
      assert.ok(state !== null, 'phase 5b: shadow should be bootstrapped');
      assert.equal(state.permissionMode, 'manual', `phase 5b: shadow.permissionMode=${state.permissionMode}, want manual (held)`);
      assert.equal(
        log.length,
        logAfterPhase5a.length,
        `phase 5b: content-only submit MUST NOT grow dispatch-log; was ${logAfterPhase5a.length}, now ${log.length}. New entries: ${JSON.stringify(log.slice(logAfterPhase5a.length))}`,
      );
      console.log(`▶ phase 5b: content-only prompt — shadow held, +0 dispatches ✓`);
    }

    console.log(`✓ 04-stateless-controls: per-request controls diff-dispatched across 4 prompts + stateful /meta verified (via /debug)`);
  } finally {
    try {
      if (sid) await client.archiveSession(sid);
    } catch {
      // ignore
    }
    await client.close();
  }
}

main().catch((err) => {
  console.error('✗ 04-stateless-controls failed:', err);
  process.exit(1);
});
