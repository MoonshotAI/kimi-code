import { CONVERSATION_FRAME_TYPES } from '@moonshot-ai/testkit/kap';
import { held, say, withUsage } from '@moonshot-ai/testkit/model';
import { expect, test as base } from 'vitest';

import { checkArtifact } from './support/artifacts';
import { normalizeRecording } from './support/recording';
import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const test = base.extend<ScenarioFixtures>(scenarioFixtures({ serverVersion: '0.0.0-fixture' }));

test('records a KAP first turn at visible stream checkpoints', async ({ kap, model }) => {
  const socket = await kap.connect();
  const { id } = await kap.createSession();
  const page = () => kap.rest.get(`/api/v1/sessions/${id}/agents/main/turns`);
  const initial = await page();
  const meta = await kap.rest.get<{ kimi_agent_protocol_version: string }>('/api/v1/meta');
  await socket.subscribe(id);
  let cursor = 0;
  const framesSinceCheckpoint = () => {
    const next = socket.frames.slice(cursor).filter(f => f['session_id'] === id && f['agent_id'] === 'main' && CONVERSATION_FRAME_TYPES.has(f.type));
    cursor = socket.mark();
    return next;
  };
  const subscribed = framesSinceCheckpoint();
  model.script(held('partial', withUsage({ input: 20, output: 3 }, say(['First', ' answer'])), 1));
  await kap.prompt(id, 'A question');
  await model.hold('partial').reached();
  let partial;
  try {
    await expect.poll(() => socket.turns(id)[0]?.items.find(item => item.type === 'assistant_message')?.['text']).toBe('First');
    partial = framesSinceCheckpoint();
  } finally {
    model.hold('partial').release();
  }
  await kap.waitIdle(id);
  await socket.waitFor(f => f.type === 'turn.ended' && f['session_id'] === id);
  const completed = framesSinceCheckpoint();
  const final = await page();
  const spec = await (await kap.rest.raw('/openapi.json')).json() as { info: { version: string } };
  await checkArtifact(new URL('./recordings/first-turn/trace.json', import.meta.url), normalizeRecording({
    format: 1, serverVersion: spec.info.version, kapVersion: meta.kimi_agent_protocol_version, initial, checkpoints: [
      { name: 'subscribed', frames: subscribed }, { name: 'partial', frames: partial }, { name: 'completed', frames: completed },
    ], final,
  }), 'replay');
});
