/**
 * Send prompt + cancel prompt live-server invariant.
 *
 * Verifies the server can arbitrarily start and stop prompts:
 *   1. submit a prompt and wait for `prompt.completed`;
 *   2. inject an active prompt via the debug hook, queue a second prompt,
 *      abort it by prompt_id, and observe `prompt.aborted`;
 *   3. inject another active prompt and cancel it via session-level
 *      `POST /sessions/{sid}:abort` (no prompt_id required);
 *   4. submit a prompt after cancellations and assert the scheduler recovers.
 *
 * Requires a server launched with debug endpoints enabled. Normal production
 * daemons do not expose `/debug/*`, so this file skips when that surface is
 * absent.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { DaemonClient, EnvelopeError, type AnyFrame } from '../src/index.js';
import { fetchWithReport } from '../src/report.js';
import { createCaseLogger, errorForLog } from './log.js';

const BASE_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const API_PREFIX = '/api/v1';
const PROMPT_TIMEOUT_MS = 120_000;
const SHORT_TIMEOUT_MS = 30_000;

async function daemonReachable(): Promise<boolean> {
  try {
    const res = await fetchWithReport(`${BASE_URL}${API_PREFIX}/meta`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function debugPromptsReachable(): Promise<boolean> {
  try {
    const res = await fetchWithReport(
      `${BASE_URL}${API_PREFIX}/debug/prompts/debug_probe/state`,
      { signal: AbortSignal.timeout(500) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await daemonReachable();
const debugReachable = reachable && (await debugPromptsReachable());
const describeLive = debugReachable ? describe : describe.skip;

const created: Array<{ client: DaemonClient; sid: string; promptIds: string[] }> = [];

afterEach(async () => {
  for (const { client, sid, promptIds } of created.splice(0)) {
    for (const promptId of promptIds.toReversed()) {
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
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
});

describeLive('send prompt + cancel prompt (live server required)', () => {
  it(
    'submits a prompt and receives prompt.completed',
    async () => {
      const log = createCaseLogger('send: prompt completes');
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({
        title: 'server-e2e send and cancel',
        metadata: { cwd: process.cwd(), scenario: 'send-and-cancel' },
      });
      const cleanup = { client, sid: session.id, promptIds: [] as string[] };
      created.push(cleanup);
      log('created session', session);

      await client.connect();
      await client.subscribe(session.id);
      log('subscribe accepted', { session_id: session.id });

      const result = await client.submitAndWait(
        session.id,
        { content: [{ type: 'text', text: 'Reply with the single word "OK".' }] },
        { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
      );
      cleanup.promptIds.push(result.prompt_id);
      log('prompt completed', {
        prompt_id: result.prompt_id,
        final_frame: frameForLog(result.finalFrame),
      });

      expect(result.prompt_id).toMatch(/^prompt_/);
      expect(result.finalFrame.type).toBe('prompt.completed');
    },
    PROMPT_TIMEOUT_MS + SHORT_TIMEOUT_MS,
  );

  it(
    'aborts a queued prompt and receives prompt.aborted',
    async () => {
      const log = createCaseLogger('cancel: queued prompt abort');
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({
        title: 'server-e2e send and cancel',
        metadata: { cwd: process.cwd(), scenario: 'send-and-cancel' },
      });
      const cleanup = { client, sid: session.id, promptIds: [] as string[] };
      created.push(cleanup);
      log('created session', session);

      await client.connect();
      await client.subscribe(session.id);
      log('subscribe accepted', { session_id: session.id });

      const active = await injectActivePrompt(session.id, {
        prompt_id: `prompt_debug_cancel_queued_${process.pid}`,
      });
      log('debug active prompt injected', active);
      cleanup.promptIds.push(active.prompt_id);

      const queued = await client.submitPrompt(session.id, {
        content: [{ type: 'text', text: 'Count slowly to 100.' }],
      });
      cleanup.promptIds.push(queued.prompt_id);
      log('queued prompt submitted', queued);
      expect(queued.status).toBe('queued');

      const listedBefore = await client.listPrompts(session.id);
      log('prompt list before abort', listedBefore);
      expect(listedBefore.active?.prompt_id).toBe(active.prompt_id);
      expect(listedBefore.queued.map((prompt) => prompt.prompt_id)).toEqual([
        queued.prompt_id,
      ]);

      const abortedFramePromise = client.waitForFrame(
        (f) =>
          f.type === 'prompt.aborted' &&
          (f.payload as { promptId?: string } | undefined)?.promptId === queued.prompt_id,
        { timeoutMs: SHORT_TIMEOUT_MS },
      );

      const abort = await client.abortPrompt(session.id, queued.prompt_id);
      log('abort response', abort);
      expect(abort.aborted).toBe(true);

      const abortedFrame = await abortedFramePromise;
      log('prompt.aborted frame', frameForLog(abortedFrame));
      expect(abortedFrame.type).toBe('prompt.aborted');

      const listedAfter = await client.listPrompts(session.id);
      log('prompt list after abort', listedAfter);
      expect(listedAfter.queued).toHaveLength(0);
    },
    PROMPT_TIMEOUT_MS + SHORT_TIMEOUT_MS,
  );

  it(
    'aborts an active prompt via session-level abort',
    async () => {
      const log = createCaseLogger('cancel: session-level abort');
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({
        title: 'server-e2e send and cancel',
        metadata: { cwd: process.cwd(), scenario: 'send-and-cancel' },
      });
      const cleanup = { client, sid: session.id, promptIds: [] as string[] };
      created.push(cleanup);
      log('created session', session);

      await client.connect();
      await client.subscribe(session.id);
      log('subscribe accepted', { session_id: session.id });

      const active = await injectActivePrompt(session.id, {
        prompt_id: `prompt_debug_cancel_session_${process.pid}`,
      });
      cleanup.promptIds.push(active.prompt_id);
      log('debug active prompt injected', active);

      const listedBefore = await client.listPrompts(session.id);
      log('prompt list before session abort', listedBefore);
      expect(listedBefore.active?.prompt_id).toBe(active.prompt_id);

      const abortedFramePromise = client.waitForFrame(
        (f) =>
          f.type === 'prompt.aborted' &&
          (f.payload as { promptId?: string } | undefined)?.promptId === active.prompt_id,
        { timeoutMs: SHORT_TIMEOUT_MS },
      );

      const abort = await client.abortSession(session.id);
      log('session abort response', abort);
      expect(abort.aborted).toBe(true);

      const abortedFrame = await abortedFramePromise;
      log('prompt.aborted frame', frameForLog(abortedFrame));
      expect(abortedFrame.type).toBe('prompt.aborted');

      const listedAfter = await client.listPrompts(session.id);
      log('prompt list after session abort', listedAfter);
      expect(listedAfter.active).toBeNull();
    },
    PROMPT_TIMEOUT_MS + SHORT_TIMEOUT_MS,
  );

  it(
    'recovers and completes a prompt after aborts',
    async () => {
      const log = createCaseLogger('send: scheduler recovery after abort');
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({
        title: 'server-e2e send and cancel',
        metadata: { cwd: process.cwd(), scenario: 'send-and-cancel' },
      });
      const cleanup = { client, sid: session.id, promptIds: [] as string[] };
      created.push(cleanup);
      log('created session', session);

      await client.connect();
      await client.subscribe(session.id);
      log('subscribe accepted', { session_id: session.id });

      const active = await injectActivePrompt(session.id, {
        prompt_id: `prompt_debug_cancel_recovery_${process.pid}`,
      });
      cleanup.promptIds.push(active.prompt_id);
      log('debug active prompt injected', active);

      const abort = await client.abortSession(session.id);
      log('session abort response', abort);
      expect(abort.aborted).toBe(true);

      const result = await client.submitAndWait(
        session.id,
        { content: [{ type: 'text', text: 'Reply with the single word "RECOVERED".' }] },
        { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
      );
      cleanup.promptIds.push(result.prompt_id);
      log('recovered prompt completed', {
        prompt_id: result.prompt_id,
        final_frame: frameForLog(result.finalFrame),
      });

      expect(result.finalFrame.type).toBe('prompt.completed');
    },
    PROMPT_TIMEOUT_MS + SHORT_TIMEOUT_MS,
  );

  it(
    'idempotently aborts a prompt on repeated ESC',
    async () => {
      const log = createCaseLogger('cancel: repeated ESC idempotent');
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({
        title: 'server-e2e send and cancel',
        metadata: { cwd: process.cwd(), scenario: 'send-and-cancel' },
      });
      const cleanup = { client, sid: session.id, promptIds: [] as string[] };
      created.push(cleanup);
      log('created session', session);

      await client.connect();
      await client.subscribe(session.id);
      log('subscribe accepted', { session_id: session.id });

      const active = await injectActivePrompt(session.id, {
        prompt_id: `prompt_debug_repeated_esc_${process.pid}`,
      });
      cleanup.promptIds.push(active.prompt_id);
      log('debug active prompt injected', active);

      const abortedFramePromise = client.waitForFrame(
        (f) =>
          f.type === 'prompt.aborted' &&
          (f.payload as { promptId?: string } | undefined)?.promptId === active.prompt_id,
        { timeoutMs: SHORT_TIMEOUT_MS },
      );

      const first = await client.abortPrompt(session.id, active.prompt_id);
      log('first ESC abort response', first);
      expect(first.aborted).toBe(true);

      const abortedFrame = await abortedFramePromise;
      log('prompt.aborted frame', frameForLog(abortedFrame));
      expect(abortedFrame.type).toBe('prompt.aborted');

      let secondError: unknown;
      try {
        await client.abortPrompt(session.id, active.prompt_id);
      } catch (error) {
        secondError = error;
      }
      log('second ESC abort error', errorForLog(secondError));
      expect(secondError).toBeInstanceOf(EnvelopeError);
      expect((secondError as EnvelopeError).code).toBe(40903);
      expect((secondError as EnvelopeError).data).toEqual({ aborted: false });

      const listed = await client.listPrompts(session.id);
      log('prompt list after repeated ESC', listed);
      expect(listed.active).toBeNull();
    },
    PROMPT_TIMEOUT_MS + SHORT_TIMEOUT_MS,
  );

  it(
    'remains stable when session-level abort is sent repeatedly',
    async () => {
      const log = createCaseLogger('cancel: repeated session-level ESC stable');
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({
        title: 'server-e2e send and cancel',
        metadata: { cwd: process.cwd(), scenario: 'send-and-cancel' },
      });
      const cleanup = { client, sid: session.id, promptIds: [] as string[] };
      created.push(cleanup);
      log('created session', session);

      await client.connect();
      await client.subscribe(session.id);
      log('subscribe accepted', { session_id: session.id });

      const active = await injectActivePrompt(session.id, {
        prompt_id: `prompt_debug_repeated_session_abort_${process.pid}`,
      });
      cleanup.promptIds.push(active.prompt_id);
      log('debug active prompt injected', active);

      const abortedFrames: AnyFrame[] = [];
      const unsubscribe = client.onFrame((f) => {
        if (
          f.type === 'prompt.aborted' &&
          (f.payload as { promptId?: string } | undefined)?.promptId === active.prompt_id
        ) {
          abortedFrames.push(f);
        }
      });
      try {
        const first = await client.abortSession(session.id);
        log('first session-level ESC abort response', first);
        expect(first.aborted).toBe(true);

        const second = await client.abortSession(session.id);
        log('second session-level ESC abort response', second);
        expect(second.aborted).toBe(true);

        const third = await client.abortSession(session.id);
        log('third session-level ESC abort response', third);
        expect(third.aborted).toBe(true);

        expect(abortedFrames).toHaveLength(1);
      } finally {
        unsubscribe();
      }

      const listed = await client.listPrompts(session.id);
      log('prompt list after repeated session-level abort', listed);
      expect(listed.active).toBeNull();
    },
    PROMPT_TIMEOUT_MS + SHORT_TIMEOUT_MS,
  );
});

function frameForLog(frame: AnyFrame): Record<string, unknown> {
  return {
    type: frame.type,
    seq: frame.seq,
    session_id: frame.session_id,
    payload: frame.payload,
  };
}

async function injectActivePrompt(
  sid: string,
  body: { prompt_id: string },
): Promise<{ prompt_id: string }> {
  const res = await fetchWithReport(
    `${BASE_URL}${API_PREFIX}/debug/prompts/${encodeURIComponent(sid)}/active`,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const envelope = (await res.json()) as {
    code: number;
    msg: string;
    data: { prompt_id: string };
  };
  expect(envelope.code, envelope.msg).toBe(0);
  return envelope.data;
}
