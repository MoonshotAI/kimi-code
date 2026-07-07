#!/usr/bin/env node
/**
 * Scenario 12 — send prompt + cancel prompt.
 *
 * Verifies that the server can arbitrarily start and stop prompts through
 * the REST + WS surface:
 *
 *   1. create and subscribe to a session;
 *   2. submit a simple prompt and wait for `prompt.completed`;
 *   3. inject an active prompt via the debug hook, submit a second prompt
 *      (queued), then abort the queued prompt and observe `prompt.aborted`;
 *   4. inject another active prompt and cancel it with the session-level
 *      `POST /sessions/{sid}:abort` endpoint (no prompt_id required);
 *   5. submit a third prompt after the cancellations and assert it completes,
 *      proving the scheduler recovers to an idle state.
 *
 * The server must be launched with `--debug-endpoints` because normal prompt
 * submission usually completes too quickly to deterministically hold an active
 * turn while queued prompts are submitted.
 *
 * Usage:
 *   KIMI_SERVER_URL=http://127.0.0.1:58627 npx tsx scenarios/12-send-and-cancel.ts
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
const PROMPT_TIMEOUT_MS = 120_000;

interface Envelope<T> {
  code: number;
  msg?: string;
  data: T | null;
}

async function main() {
  const client = new DaemonClient({ baseUrl: KIMI_SERVER_URL });

  let sid: string | undefined;
  const promptIdsForCleanup: string[] = [];
  try {
    const session = await client.createSession({
      title: 'server-e2e send and cancel',
      metadata: { cwd: process.cwd(), scenario: 'send-and-cancel' },
    });
    sid = session.id;
    console.log(`▶ session ${sid} created`);

    await client.connect();
    await client.subscribe(sid);
    console.log(`▶ session ${sid} subscribed`);

    // 1. Happy-path send: submit a prompt and wait for completion.
    const completed = await client.submitAndWait(
      sid,
      { content: [{ type: 'text', text: 'Reply with the single word "OK".' }] },
      { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
    );
    promptIdsForCleanup.push(completed.prompt_id);
    console.log(`▶ prompt completed: ${completed.prompt_id}`);
    assert.equal(completed.finalFrame.type, 'prompt.completed');

    // 2. Cancel a queued prompt: hold the turn with a debug active prompt,
    //    submit a second prompt, then abort it by prompt_id.
    const activeForQueued = await injectActivePrompt(sid, {
      prompt_id: `prompt_debug_cancel_queued_${process.pid}`,
    });
    promptIdsForCleanup.push(activeForQueued.prompt_id);
    console.log(`▶ injected active prompt for queued cancel: ${activeForQueued.prompt_id}`);

    const queued = await client.submitPrompt(sid, {
      content: [{ type: 'text', text: 'Count slowly to 100.' }],
    });
    promptIdsForCleanup.push(queued.prompt_id);
    assert.equal(queued.status, 'queued', `queued prompt status=${queued.status}, want queued`);
    console.log(`▶ queued prompt submitted: ${queued.prompt_id}`);

    const abortedFramePromise = client.waitForFrame(
      (f) =>
        f.type === 'prompt.aborted' &&
        (f.payload as { promptId?: string } | undefined)?.promptId === queued.prompt_id,
      { timeoutMs: 30_000 },
    );

    const abortQueued = await client.abortPrompt(sid, queued.prompt_id);
    console.log(`▶ abort queued response: ${JSON.stringify(abortQueued)}`);
    assert.equal(abortQueued.aborted, true);

    const abortedFrame = await abortedFramePromise;
    assert.equal(abortedFrame.type, 'prompt.aborted');
    console.log(`▶ prompt.aborted frame received for queued prompt ${queued.prompt_id}`);

    // 3. Cancel an active prompt via session-level abort (no prompt_id).
    const activeForSession = await injectActivePrompt(sid, {
      prompt_id: `prompt_debug_cancel_session_${process.pid}`,
    });
    promptIdsForCleanup.push(activeForSession.prompt_id);
    console.log(`▶ injected active prompt for session abort: ${activeForSession.prompt_id}`);

    const sessionAbortFramePromise = client.waitForFrame(
      (f) =>
        f.type === 'prompt.aborted' &&
        (f.payload as { promptId?: string } | undefined)?.promptId === activeForSession.prompt_id,
      { timeoutMs: 30_000 },
    );

    const sessionAbort = await client.abortSession(sid);
    console.log(`▶ session abort response: ${JSON.stringify(sessionAbort)}`);
    assert.equal(sessionAbort.aborted, true);

    const sessionAbortFrame = await sessionAbortFramePromise;
    assert.equal(sessionAbortFrame.type, 'prompt.aborted');
    console.log(`▶ prompt.aborted frame received for session-aborted prompt ${activeForSession.prompt_id}`);

    // 4. Repeated ESC (prompt-level): abort an active prompt, then abort it
    //    again and assert idempotent 40903 / { aborted: false }.
    const activeForRepeated = await injectActivePrompt(sid, {
      prompt_id: `prompt_debug_repeated_esc_${process.pid}`,
    });
    promptIdsForCleanup.push(activeForRepeated.prompt_id);
    console.log(`▶ injected active prompt for repeated ESC: ${activeForRepeated.prompt_id}`);

    const repeatedEscFramePromise = client.waitForFrame(
      (f) =>
        f.type === 'prompt.aborted' &&
        (f.payload as { promptId?: string } | undefined)?.promptId === activeForRepeated.prompt_id,
      { timeoutMs: 30_000 },
    );

    const firstEsc = await client.abortPrompt(sid, activeForRepeated.prompt_id);
    console.log(`▶ first ESC abort response: ${JSON.stringify(firstEsc)}`);
    assert.equal(firstEsc.aborted, true);

    const repeatedEscFrame = await repeatedEscFramePromise;
    assert.equal(repeatedEscFrame.type, 'prompt.aborted');
    console.log(`▶ prompt.aborted frame received for repeated ESC prompt ${activeForRepeated.prompt_id}`);

    let secondEscError: unknown;
    try {
      await client.abortPrompt(sid, activeForRepeated.prompt_id);
    } catch (error) {
      secondEscError = error;
    }
    assert.ok(
      secondEscError instanceof Error && secondEscError.message.includes('40903'),
      `expected second ESC to return 40903, got ${String(secondEscError)}`,
    );
    console.log(`▶ second ESC abort returned 40903 as expected`);

    // 5. Repeated session-level ESC: cancel repeatedly and assert stability.
    const activeForRepeatedSession = await injectActivePrompt(sid, {
      prompt_id: `prompt_debug_repeated_session_abort_${process.pid}`,
    });
    promptIdsForCleanup.push(activeForRepeatedSession.prompt_id);
    console.log(`▶ injected active prompt for repeated session abort: ${activeForRepeatedSession.prompt_id}`);

    const repeatedSessionFrames: Array<{ type: string; promptId?: string }> = [];
    const unsubscribe = client.onFrame((f) => {
      if (
        f.type === 'prompt.aborted' &&
        (f.payload as { promptId?: string } | undefined)?.promptId === activeForRepeatedSession.prompt_id
      ) {
        repeatedSessionFrames.push({ type: f.type, promptId: (f.payload as { promptId?: string }).promptId });
      }
    });
    try {
      const firstSessionAbort = await client.abortSession(sid);
      console.log(`▶ first session-level ESC abort response: ${JSON.stringify(firstSessionAbort)}`);
      assert.equal(firstSessionAbort.aborted, true);

      const secondSessionAbort = await client.abortSession(sid);
      console.log(`▶ second session-level ESC abort response: ${JSON.stringify(secondSessionAbort)}`);
      assert.equal(secondSessionAbort.aborted, true);

      const thirdSessionAbort = await client.abortSession(sid);
      console.log(`▶ third session-level ESC abort response: ${JSON.stringify(thirdSessionAbort)}`);
      assert.equal(thirdSessionAbort.aborted, true);

      assert.equal(repeatedSessionFrames.length, 1, `expected exactly one prompt.aborted frame, got ${repeatedSessionFrames.length}`);
      console.log(`▶ repeated session-level ESC produced exactly one prompt.aborted frame`);
    } finally {
      unsubscribe();
    }

    // 6. Scheduler recovery: submit another prompt after cancellations and
    //    assert it completes normally.
    const recovered = await client.submitAndWait(
      sid,
      { content: [{ type: 'text', text: 'Reply with the single word "RECOVERED".' }] },
      { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
    );
    promptIdsForCleanup.push(recovered.prompt_id);
    console.log(`▶ recovered prompt completed: ${recovered.prompt_id}`);
    assert.equal(recovered.finalFrame.type, 'prompt.completed');

    console.log('✓ 12-send-and-cancel: submit + abort round-trips succeeded');
  } finally {
    if (sid !== undefined) {
      for (const promptId of promptIdsForCleanup.toReversed()) {
        try {
          await client.abortPrompt(sid, promptId);
        } catch {
          // ignore
        }
      }
      try {
        await client.archiveSession(sid);
      } catch {
        // ignore
      }
    }
    await client.close();
  }
}

async function injectActivePrompt(
  sid: string,
  body: { prompt_id: string },
): Promise<{ prompt_id: string }> {
  const url = `${KIMI_SERVER_URL}${API_PREFIX}/debug/prompts/${encodeURIComponent(sid)}/active`;
  const res = await fetchWithReport(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 404) {
    throw new Error(`POST ${url} -> 404. Did you start the server with --debug-endpoints?`);
  }
  const envelope = (await res.json()) as Envelope<{ prompt_id: string }>;
  if (envelope.code !== 0 || envelope.data === null) {
    throw new Error(`POST ${url} -> code=${envelope.code} msg=${envelope.msg ?? ''}`);
  }
  return envelope.data;
}

main().catch((error) => {
  console.error('✗ 12-send-and-cancel failed:', error);
  process.exit(1);
});
