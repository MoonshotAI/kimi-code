/**
 * Scenario: a v2 UserPromptSubmit hook completes an ACP prompt before any turn launches.
 * Responsibilities: settle the correlated ACP request and release admission for later prompts.
 * Wiring: real v2 harness, hook process, node SDK, ACP NDJSON, and loopback model protocol;
 * only the remote Chat Completions endpoint is stubbed.
 * Run: pnpm --filter @moonshot-ai/acp-adapter exec vitest run test/prompt-admission-v2.e2e.test.ts
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Event } from '@moonshot-ai/kimi-code-sdk';

import {
  createRealEngineRig,
  type RealEngineRig,
} from './_helpers/real-engine-rig';

const BLOCKING_HOOK_CONFIG = `
[[hooks]]
event = "UserPromptSubmit"
matcher = "block this request"
command = "node -e \\"process.stderr.write('blocked by test');process.exit(2)\\""
timeout = 5
`;

let rig: RealEngineRig | undefined;
const eventSubscriptions: Array<() => void> = [];

afterEach(async () => {
  for (const unsubscribe of eventSubscriptions.splice(0)) {
    unsubscribe();
  }
  try {
    await rig?.close();
  } finally {
    rig = undefined;
  }
});

describe('ACP v2 no-turn prompt admission', () => {
  it(
    'returns refusal when the hook blocks before turn launch',
    async () => {
      rig = await createAdmissionRig();
      const events = collectEvents(rig);

      await expect(
        rig.client.prompt({
          sessionId: rig.session.id,
          prompt: [{ type: 'text', text: 'block this request' }],
        }),
      ).resolves.toEqual({ stopReason: 'refusal' });

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'prompt.completed',
          promptId: expect.any(String),
          reason: 'blocked',
        }),
      );
      expect(events.some((event) => event.type === 'turn.started')).toBe(false);
      expect(rig.modelRequests).toHaveLength(0);
    },
    30_000,
  );

  it(
    'admits a later request after the hook blocks the preceding prompt',
    async () => {
      rig = await createAdmissionRig();
      const events = collectEvents(rig);
      await rig.client.prompt({
        sessionId: rig.session.id,
        prompt: [{ type: 'text', text: 'block this request' }],
      });
      const reply = rig.collecting.waitForUpdate(
        (notification) =>
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === 'Later prompt completed.',
        'later prompt assistant reply',
      );

      await expect(
        rig.client.prompt({
          sessionId: rig.session.id,
          prompt: [{ type: 'text', text: 'allow this request' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      await reply;

      const completedIndex = events.findIndex(
        (event) => event.type === 'prompt.completed' && event.reason === 'blocked',
      );
      const startedIndex = events.findIndex((event) => event.type === 'turn.started');
      const endedIndex = events.findIndex((event) => event.type === 'turn.ended');
      expect(completedIndex).toBeGreaterThanOrEqual(0);
      expect(startedIndex).toBeGreaterThan(completedIndex);
      expect(endedIndex).toBeGreaterThan(startedIndex);
      expect(rig.modelRequests).toHaveLength(1);
      expect(rig.modelRequests[0]).toMatchObject({
        authorization: 'Bearer YOUR_API_KEY',
        body: {
          model: 'stub-model',
          stream: true,
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.stringContaining('allow this request'),
            }),
          ]),
        },
      });
    },
    30_000,
  );
});

async function createAdmissionRig(): Promise<RealEngineRig> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-acp-v2-hook-home-'));
  const workDir = await mkdtemp(join(tmpdir(), 'kimi-acp-v2-hook-work-'));
  return createRealEngineRig({
    engine: 'v2',
    homeDir,
    workDir,
    replies: [{ kind: 'text', text: 'Later prompt completed.' }],
    additionalConfig: BLOCKING_HOOK_CONFIG,
  });
}

function collectEvents(target: RealEngineRig): Event[] {
  const events: Event[] = [];
  eventSubscriptions.push(
    target.session.onEvent((event) => {
      events.push(event);
    }),
  );
  return events;
}
