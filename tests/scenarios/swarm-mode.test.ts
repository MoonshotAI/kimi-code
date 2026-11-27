import { bash, batch, call, say } from '@moonshot-ai/testkit/model';
import { describe, expect, test as base } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const SWARM_ARGS = {
  description: 'Check two items',
  prompt_template: 'Report {{item}}.',
  items: ['alpha', 'beta'],
};

const LEGACY_ENTER_REMINDER = 'You are now in "agent swarm" mode.';

async function mainSwarmMode(kap: ScenarioFixtures['kap'], sessionId: string): Promise<unknown> {
  const socket = await kap.connect();
  await socket.subscribe(sessionId);
  const frame = await socket.waitFor(
    (candidate) =>
      candidate.type === 'agent' &&
      candidate['session_id'] === sessionId &&
      candidate['agent_id'] === 'main',
  );
  return frame['swarm_mode'];
}

describe('KIMI_CODE_SWARM=1', () => {
  const test = base.extend<ScenarioFixtures>(scenarioFixtures({ env: { KIMI_CODE_SWARM: '1' } }));

  test('enters swarm mode on new sessions, allows exit, and re-enters on the next session', async ({ kap, model }) => {
    const first = await kap.createSession();
    expect(await mainSwarmMode(kap, first.id)).toBe(true);

    model.script(call('AgentSwarm', SWARM_ARGS), say('swarm done'));
    model.lane('subagent').script(say('alpha done'), say('beta done'));
    await kap.prompt(first.id, 'run a swarm');
    await kap.waitIdle(first.id);

    const subagents = model.requests('subagent');
    expect(subagents.map((request) => request.firstUserText).toSorted()).toEqual([
      'Report alpha.',
      'Report beta.',
    ]);
    expect(model.requests('main')[1]?.texts('tool').join('\n')).toContain('<summary>completed: 2</summary>');

    model.script(batch(call('AgentSwarm', SWARM_ARGS), bash('echo hi')), say('mixed batch blocked'));
    await kap.prompt(first.id, 'run a mixed batch');
    await kap.waitIdle(first.id);

    expect(model.requests('subagent')).toHaveLength(2);
    expect(model.requests('main')[3]?.texts('tool').join('\n')).toContain(
      'AgentSwarm must be the only tool call in a model response',
    );

    const exited = await kap.rest.post(`/api/v1/sessions/${first.id}/profile`, {
      agent_config: { swarm_mode: false },
    });
    expect(exited).toMatchObject({ agent: { swarm_mode: false } });
    expect(await mainSwarmMode(kap, first.id)).toBe(false);

    model.script(call('AgentSwarm', SWARM_ARGS), say('swarm is off'));
    await kap.prompt(first.id, 'try swarm after exit');
    await kap.waitIdle(first.id);

    expect(model.requests('subagent')).toHaveLength(2);
    expect(model.requests('main')[5]?.texts('tool').join('\n')).toContain(
      'Swarm mode is off, so AgentSwarm did not run',
    );

    const second = await kap.createSession();
    expect(await mainSwarmMode(kap, second.id)).toBe(true);

    const optedOut = await kap.createSession({ agentConfig: { swarm_mode: false } });
    expect(await mainSwarmMode(kap, optedOut.id)).toBe(false);

    for (const request of model.requests()) {
      expect(request.rawBody).not.toContain(LEGACY_ENTER_REMINDER);
    }
  });
});

describe.each(['1', 'true', ' TRUE ', 'yes', 'on'])('KIMI_CODE_SWARM=%j', (value) => {
  const test = base.extend<ScenarioFixtures>(scenarioFixtures({ env: { KIMI_CODE_SWARM: value } }));

  test('starts new sessions with swarm mode active', async ({ kap }) => {
    const session = await kap.createSession();
    expect(await mainSwarmMode(kap, session.id)).toBe(true);
  });
});

describe.each([
  ['unset', undefined],
  ['empty', ''],
  ['0', '0'],
  ['false', 'false'],
  ['off', 'off'],
  ['invalid', 'invalid'],
])('KIMI_CODE_SWARM=%s', (_label, value) => {
  const test = base.extend<ScenarioFixtures>(scenarioFixtures({ env: { KIMI_CODE_SWARM: value } }));

  test('keeps new sessions out of swarm mode', async ({ kap }) => {
    const session = await kap.createSession();
    expect(await mainSwarmMode(kap, session.id)).toBe(false);
  });
});

describe('KIMI_CODE_SWARM=0', () => {
  const test = base.extend<ScenarioFixtures>(scenarioFixtures({ env: { KIMI_CODE_SWARM: '0' } }));

  test('rejects AgentSwarm until the user turns swarm mode on', async ({ kap, model }) => {
    const session = await kap.createSession();
    expect(await mainSwarmMode(kap, session.id)).toBe(false);

    model.script(call('AgentSwarm', SWARM_ARGS), say('off'), call('AgentSwarm', SWARM_ARGS), say('on'));
    model.lane('subagent').script(say('alpha done'), say('beta done'));

    await kap.prompt(session.id, 'try swarm while off');
    await kap.waitIdle(session.id);
    expect(model.requests('subagent')).toHaveLength(0);
    expect(model.requests('main')[1]?.texts('tool').join('\n')).toContain(
      'Swarm mode is off, so AgentSwarm did not run',
    );

    await kap.rest.post(`/api/v1/sessions/${session.id}/profile`, {
      agent_config: { swarm_mode: true },
    });
    await kap.prompt(session.id, 'try swarm after manual enter');
    await kap.waitIdle(session.id);
    expect(model.requests('subagent')).toHaveLength(2);
    expect(model.requests('main')[3]?.texts('tool').join('\n')).toContain('<summary>completed: 2</summary>');

    for (const request of model.requests()) {
      expect(request.rawBody).not.toContain(LEGACY_ENTER_REMINDER);
    }
  });
});
