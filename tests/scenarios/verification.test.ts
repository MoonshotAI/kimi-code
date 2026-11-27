import { bash, held, say } from '@moonshot-ai/testkit/model';
import { expect, test, vi } from 'vitest';

import { scenarioFixtures } from './support/scenario';

test('fails a scenario that leaves a reached hold unreleased', async (context) => {
  const fixtures = scenarioFixtures();
  const run = fixtures.model(context, async (model) => {
    await fixtures.kap({ ...context, model }, async (kap) => {
      model.script(held('forgotten', say('late')));
      const session = await kap.createSession();
      await kap.prompt(session.id, 'go');
      await model.hold('forgotten').reached();
    });
  });
  await expect(run).rejects.toThrow(/hold "forgotten" was reached by request #0 but never released, failed, or cut/);
});

test('passes the same scenario once it releases the hold', async (context) => {
  const fixtures = scenarioFixtures();
  const run = fixtures.model(context, async (model) => {
    await fixtures.kap({ ...context, model }, async (kap) => {
      model.script(held('released', say('late')));
      const session = await kap.createSession();
      await kap.prompt(session.id, 'go');
      await model.hold('released').reached();
      model.hold('released').release();
      await kap.waitIdle(session.id);
    });
  });
  await expect(run).resolves.toBeUndefined();
});

test('fails a scenario that ends while a background command it started is still running', { timeout: 60_000 }, async (context) => {
  const fixtures = scenarioFixtures();
  const run = fixtures.model(context, async (model) => {
    await fixtures.kap({ ...context, model }, async (kap) => {
      model.script(bash({ command: 'sleep 60', description: 'long sleep', run_in_background: true }), say('started it'));
      const socket = await kap.connect();
      const session = await kap.createSession();
      await socket.subscribe(session.id);
      await kap.prompt(session.id, 'start a long command in the background');
      await socket.waitFor((frame) => frame.type === 'task' && frame['status'] === 'running' && frame['detached'] === true);
      await socket.waitFor((frame) => frame.type === 'turn.ended' && frame['session_id'] === session.id);
    });
  });
  await expect(run).rejects.toMatchObject({ name: 'KapInvariantError', message: expect.stringMatching(/is still busy when the test ends \(activity background/) });
});

test('reports model requests, WebSocket frames and server logs when teardown fails', async (context) => {
  const fixtures = scenarioFixtures();
  const failureHooks: Parameters<typeof context.onTestFailed>[0][] = [];
  const run = fixtures.model({ ...context, onTestFailed: (hook) => { failureHooks.push(hook); } }, async (model) => {
    await fixtures.kap({ ...context, model }, async (kap) => {
      model.script(held('unfinished', say('later')));
      const session = await kap.createSession();
      const socket = await kap.connect();
      await socket.subscribe(session.id);
      await kap.cancel(session.id);
      await kap.prompt(session.id, 'diagnostic request');
      await model.hold('unfinished').reached();
      await socket.waitFor((frame) => frame.type === 'turn.started');
    });
  });
  await expect(run).rejects.toThrow(/hold "unfinished"/);
  const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    for (const hook of failureHooks) await hook(context);
    const output = write.mock.calls.map(([message]) => String(message)).join('');
    expect(output).toContain('diagnostic request');
    expect(output).toContain('openai held');
    expect(output).toContain('turn.started');
    expect(output).toContain('session action completed');
    expect(output).not.toContain('authorization');
  } finally {
    write.mockRestore();
  }
});

test('subscribes to an existing KAP session twice and reports which requested agent failed', async (context) => {
  const fixtures = scenarioFixtures();
  await fixtures.model(context, async (model) => {
    await fixtures.kap({ ...context, model }, async (kap) => {
      const socket = await kap.connect();
      const session = await kap.createSession();
      await socket.subscribe(session.id);
      await socket.subscribe(session.id);
      await expect(socket.subscribe(session.id, { agentIds: ['main', 'missing-agent'] })).rejects.toMatchObject({
        name: 'KapCommandError',
        response: { type: 'turns.failed', session_id: session.id, agent_id: 'missing-agent', msg: 'agent not found: missing-agent' },
      });
      expect(socket.frames.filter((frame) => frame.type === 'turns')).toHaveLength(1);
    });
  });
});
