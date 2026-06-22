#!/usr/bin/env node
/**
 * Scenario 10 — prompt queue steer.
 *
 * Verifies the server REST + WS contract for steering queued prompts into an
 * already-running turn:
 *
 *   1. create and subscribe to a session;
 *   2. use the debug-only prompt hook to mark one prompt active;
 *   3. submit two prompts and assert both are queued;
 *   4. call `POST /sessions/{sid}/prompts:steer` with both prompt ids;
 *   5. assert the REST response, `prompt.steered` WS frame, steered content,
 *      and final queue state.
 *
 * The server must be launched with `--debug-endpoints` because normal prompt
 * submission usually completes too quickly to deterministically hold an active
 * turn while queued prompts are submitted.
 *
 * Usage:
 *   KIMI_SERVER_URL=http://127.0.0.1:58627 npx tsx scenarios/10-prompt-queue-steer.ts
 *
 * Exit codes:
 *   0  — pass
 *   1  — assertion failure or server error
 */
import assert from 'node:assert/strict';

import { DaemonClient, type AnyFrame } from '../src/index';
import { fetchWithReport } from '../src/report';

const KIMI_SERVER_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const API_PREFIX = '/api/v1';
const PROMPT_TIMEOUT_MS = 60_000;

interface Envelope<T> {
  code: number;
  msg?: string;
  data: T | null;
}

interface PromptSteeredPayload {
  type: 'prompt.steered';
  agentId: string;
  sessionId: string;
  activePromptId: string;
  promptIds: string[];
  content: unknown[];
  steeredAt: string;
}

async function main() {
  const client = new DaemonClient({ baseUrl: KIMI_SERVER_URL });

  let sid: string | undefined;
  const promptIdsForCleanup: string[] = [];
  try {
    const session = await client.createSession({
      title: 'server-e2e prompt queue steer',
      metadata: { cwd: process.cwd(), scenario: 'prompt-queue-steer' },
    });
    sid = session.id;
    console.log(`▶ session ${sid} created`);

    await client.connect();
    await client.subscribe(sid);
    console.log(`▶ session ${sid} subscribed`);

    const active = await injectActivePrompt(sid, {
      prompt_id: `prompt_debug_queue_steer_${process.pid}`,
    });
    promptIdsForCleanup.push(active.prompt_id);
    console.log(`▶ active prompt injected: ${active.prompt_id}`);

    const firstQueued = await client.submitPrompt(sid, {
      content: [
        {
          type: 'text',
          text: 'First queued prompt for server steer.',
        },
      ],
    });
    promptIdsForCleanup.push(firstQueued.prompt_id);
    assert.equal(firstQueued.status, 'queued', `first prompt status=${firstQueued.status}, want queued`);
    console.log(`▶ first prompt queued: ${firstQueued.prompt_id}`);

    const secondQueued = await client.submitPrompt(sid, {
      content: [
        {
          type: 'text',
          text: 'Second queued prompt for server steer.',
        },
      ],
    });
    promptIdsForCleanup.push(secondQueued.prompt_id);
    assert.equal(secondQueued.status, 'queued', `second prompt status=${secondQueued.status}, want queued`);
    console.log(`▶ second prompt queued: ${secondQueued.prompt_id}`);

    const before = await client.listPrompts(sid);
    assert.equal(before.active?.prompt_id, active.prompt_id, 'expected debug prompt to remain active');
    assert.deepEqual(
      before.queued.map((prompt) => prompt.prompt_id),
      [firstQueued.prompt_id, secondQueued.prompt_id],
      'expected both submitted prompts to be queued before steer',
    );
    console.log(`▶ queue before steer: ${before.queued.map((prompt) => prompt.prompt_id).join(', ')}`);

    const promptIds = [firstQueued.prompt_id, secondQueued.prompt_id];
    const steeredFramePromise = client.waitForFrame(isPromptSteeredForAll(sid, promptIds), {
      timeoutMs: PROMPT_TIMEOUT_MS,
    });
    const steer = await client.steerPrompts(sid, promptIds);
    assert.deepEqual(steer, { steered: true, prompt_ids: promptIds });
    console.log(`▶ steer response: ${JSON.stringify(steer)}`);

    const steeredFrame = await steeredFramePromise;
    const steered = payloadOf<PromptSteeredPayload>(steeredFrame);
    assert.equal(steered.activePromptId, active.prompt_id);
    assert.deepEqual(steered.promptIds, promptIds);
    assert.deepEqual(textContentOf(steered.content), [
      'First queued prompt for server steer.',
      'Second queued prompt for server steer.',
    ]);
    console.log(`▶ prompt.steered frame: ${JSON.stringify(frameForLog(steeredFrame))}`);

    const after = await client.listPrompts(sid);
    assert.equal(after.queued.length, 0, `expected queue to be empty, got ${after.queued.length}`);
    console.log('✓ 10-prompt-queue-steer: queued prompts steered and queue drained');
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

function isPromptSteeredForAll(
  sid: string,
  promptIds: readonly string[],
): (frame: AnyFrame) => boolean {
  return (frame) => {
    if (frame.type !== 'prompt.steered' || frame.session_id !== sid) return false;
    const payload = frame.payload as { promptIds?: string[] } | undefined;
    return promptIds.every((promptId) => payload?.promptIds?.includes(promptId) === true);
  };
}

function payloadOf<T>(frame: AnyFrame): T {
  assert.ok(frame.payload, `${frame.type} frame should carry payload`);
  return frame.payload as T;
}

function textContentOf(content: unknown[]): string[] {
  return content.flatMap((part) => {
    if (
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string'
    ) {
      return [part.text];
    }
    return [];
  });
}

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
  const url = `${KIMI_SERVER_URL}${API_PREFIX}/debug/prompts/${encodeURIComponent(sid)}/active`;
  const res = await fetchWithReport(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 404) {
    throw new Error(
      `POST ${url} -> 404. Did you start the server with --debug-endpoints?`,
    );
  }
  const envelope = (await res.json()) as Envelope<{ prompt_id: string }>;
  if (envelope.code !== 0 || envelope.data === null) {
    throw new Error(`POST ${url} -> code=${envelope.code} msg=${envelope.msg ?? ''}`);
  }
  return envelope.data;
}

main().catch((err) => {
  console.error('✗ 10-prompt-queue-steer failed:', err);
  process.exit(1);
});
