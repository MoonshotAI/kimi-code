/**
 * Prompt queue + steer live-server invariant.
 *
 * Drives the TUI Ctrl-S equivalent over server REST + WS:
 *   1. use the debug-only prompt test hook to mark one prompt active;
 *   2. submit a second prompt and assert it is queued instead of rejected;
 *   3. list prompts and assert active + queued state;
 *   4. steer the queued prompt and assert `prompt.steered` is broadcast and
 *      the queue is drained.
 *
 * Requires a server launched with debug endpoints enabled. Normal production
 * daemons do not expose `/debug/*`, so this file skips when that surface is
 * absent.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { DaemonClient, type AnyFrame } from '../src/index.js';
import { fetchWithReport } from '../src/report.js';
import { createCaseLogger } from './log.js';

const BASE_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const API_PREFIX = '/api/v1';
const SHORT_TIMEOUT_MS = 15_000;

interface PromptSteeredPayload {
  type: 'prompt.steered';
  sessionId: string;
  activePromptId: string;
  promptIds: string[];
  content: unknown[];
  steeredAt: string;
}

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
const debugReachable = reachable && await debugPromptsReachable();
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

describeLive('prompt queue + steer (live server required)', () => {
  it(
    'queues a busy prompt and steers it into the active turn',
    async () => {
      const log = createCaseLogger('prompt queue: steer');
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({
        title: 'server-e2e prompt queue steer',
        metadata: { cwd: process.cwd(), scenario: 'prompt-queue-steer' },
      });
      const cleanup: { client: DaemonClient; sid: string; promptIds: string[] } = {
        client,
        sid: session.id,
        promptIds: [],
      };
      created.push(cleanup);
      log('created session', session);

      await client.connect();
      await client.subscribe(session.id);
      log('subscribe accepted', { session_id: session.id });

      const active = await injectActivePrompt(session.id, {
        prompt_id: `prompt_debug_queue_steer_${process.pid}`,
      });
      log('debug active prompt injected', active);
      cleanup.promptIds.push(active.prompt_id);

      const queued = await client.submitPrompt(session.id, {
        content: [
          {
            type: 'text',
            text: 'This queued prompt should be steered into the active turn.',
          },
        ],
      });
      log('queued prompt submitted', queued);
      cleanup.promptIds.push(queued.prompt_id);
      expect(queued.status).toBe('queued');

      const listedBefore = await client.listPrompts(session.id);
      log('prompt list before steer', listedBefore);
      expect(listedBefore.active?.prompt_id).toBe(active.prompt_id);
      expect(listedBefore.queued.map((prompt) => prompt.prompt_id)).toEqual([
        queued.prompt_id,
      ]);

      const steerFramePromise = client.waitForFrame(isPromptSteeredFor(session.id, queued.prompt_id), {
        timeoutMs: SHORT_TIMEOUT_MS,
      });
      const steer = await client.steerPrompt(session.id, queued.prompt_id);
      log('steer response', steer);
      expect(steer).toEqual({ steered: true, prompt_ids: [queued.prompt_id] });

      const steerFrame = await steerFramePromise;
      const steered = payloadOf<PromptSteeredPayload>(steerFrame);
      log('prompt.steered frame', {
        frame: frameForLog(steerFrame),
        steered,
      });
      expect(steered.activePromptId).toBe(active.prompt_id);
      expect(steered.promptIds).toEqual([queued.prompt_id]);

      const listedAfter = await client.listPrompts(session.id);
      log('prompt list after steer', listedAfter);
      expect(listedAfter.queued).toHaveLength(0);
    },
    SHORT_TIMEOUT_MS + 30_000,
  );
});

function isPromptSteeredFor(sid: string, promptId: string): (frame: AnyFrame) => boolean {
  return (frame) => {
    if (frame.type !== 'prompt.steered' || frame.session_id !== sid) return false;
    const payload = frame.payload as { promptIds?: string[] } | undefined;
    return payload?.promptIds?.includes(promptId) === true;
  };
}

function payloadOf<T>(frame: AnyFrame): T {
  expect(frame.payload, `${frame.type} frame should carry payload`).toBeDefined();
  return frame.payload as T;
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
  const res = await fetchWithReport(
    `${BASE_URL}${API_PREFIX}/debug/prompts/${encodeURIComponent(sid)}/active`,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const envelope = await res.json() as {
    code: number;
    msg: string;
    data: { prompt_id: string };
  };
  expect(envelope.code, envelope.msg).toBe(0);
  return envelope.data;
}
