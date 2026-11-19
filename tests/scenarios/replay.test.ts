import { fileURLToPath } from 'node:url';

import { expectGolden } from '@moonshot-ai/testkit/fixtures';
import { KapRecorder, type KapTurnsPage } from '@moonshot-ai/testkit/kap';
import { held, say, withUsage } from '@moonshot-ai/testkit/model';
import { expect, test as base } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const test = base.extend<ScenarioFixtures>(scenarioFixtures({ serverVersion: '0.0.0-fixture' }));

test('records a KAP first turn at visible stream checkpoints, with a second client that subscribes mid-turn', async ({ kap, model }) => {
  const socket = await kap.connect();
  const { id } = await kap.createSession();
  const page = () => kap.rest.get<KapTurnsPage>(`/api/v1/sessions/${id}/agents/main/turns`);
  const initial = await page();
  const meta = await kap.rest.get<{ kimi_agent_protocol_version: string }>('/api/v1/meta');
  const recorder = new KapRecorder(id);
  recorder.watch('primary', socket);
  await socket.subscribe(id);
  recorder.checkpoint('subscribed');
  model.script(held('partial', withUsage({ input: 20, output: 3 }, say(['First', ' answer'])), 1));
  const late = await kap.connect();
  let lateInitial = initial;
  await kap.prompt(id, 'A question');
  await model.hold('partial').reached();
  try {
    await expect.poll(() => socket.turns(id)[0]?.items.find(item => item.type === 'assistant_message')?.['text']).toBe('First');
    recorder.checkpoint('partial');
    lateInitial = await page();
    recorder.watch('late', late);
    await late.subscribe(id);
    await expect.poll(() => late.turns(id)[0]?.items.find(item => item.type === 'assistant_message')?.['text']).toBe('First');
    recorder.checkpoint('late-subscribed');
  } finally {
    model.hold('partial').release();
  }
  await kap.waitIdle(id);
  await socket.waitFor(f => f.type === 'turn.ended' && f['session_id'] === id);
  await late.waitFor(f => f.type === 'turn.ended' && f['session_id'] === id);
  recorder.checkpoint('completed');
  const final = await page();
  const spec = await (await kap.rest.raw('/openapi.json')).json() as { info: { version: string } };
  const recording = recorder.recording({
    serverVersion: spec.info.version,
    kapVersion: meta.kimi_agent_protocol_version,
    pages: { primary: { initial, final }, late: { initial: lateInitial, final } },
  });
  await expectGolden(fileURLToPath(new URL('./recordings/first-turn/trace.json', import.meta.url)), recording, {
    kind: 'replay',
    refreshCommand: 'pnpm qa:refresh replay',
  });
});
