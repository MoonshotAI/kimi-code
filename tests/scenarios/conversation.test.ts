import { once } from 'node:events';

import { deferred } from '@moonshot-ai/testkit/fixtures';
import { agent, bash, held, httpError, say, think } from '@moonshot-ai/testkit/model';
import { test as base, describe, expect } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const test = base.extend<ScenarioFixtures>(scenarioFixtures());

describe('conversation over KAP', () => {
  test('[L0:kap.first-turn] streams a reply live and persists the same turns', { tags: ['smoke'] }, async ({ kap, model }) => {
    model.script(held('before-final-text', think('pondering', say(['Hel', 'lo'])), 2));
    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);

    const prompt = await kap.prompt(session.id, 'hi');
    const hold = model.hold('before-final-text');
    await hold.reached();
    try {
      await expect.poll(() => socket.turns(session.id)[0]?.items.find(item => item.type === 'assistant_message')?.['text']).toBe('Hel');
    } finally {
      hold.release();
    }
    await kap.waitIdle(session.id);
    await socket.waitFor((frame) => frame.type === 'turn.ended' && frame['session_id'] === session.id);

    const persisted = await kap.turns(session.id);
    expect(socket.turns(session.id)).toEqual(persisted);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(persisted[0]?.items[0]).toMatchObject({ type: 'user_message', prompt_ids: [prompt.prompt_id] });
    expect(persisted[0]?.items.map((item) => [item.type, item['text']])).toEqual([
      ['user_message', 'hi'],
      ['reasoning', 'pondering'],
      ['assistant_message', 'Hello'],
    ]);
    expect(model.request(0)).toMatchObject({ lane: 'main', firstUserText: 'hi', metadata: { agentRole: 'main', stepReason: 'turn_start' } });
  });

  test('runs a tool call and sends its result back to the model', async ({ kap, model }) => {
    model.script(bash('echo testkit-ok'), say('done'));
    const session = await kap.createSession();

    await kap.prompt(session.id, 'run it');
    await kap.waitIdle(session.id);

    const followUp = model.request(1);
    expect(followUp.metadata).toMatchObject({ stepReason: 'tool_results' });
    expect(followUp.view.messages.find((message) => message.role === 'tool')).toMatchObject({
      callId: model.callId(0, 0),
      text: 'testkit-ok\n',
    });
    const [turn] = await kap.turns(session.id);
    expect(turn?.items.find((item) => item.type === 'tool_call')).toMatchObject({
      item_id: model.callId(0, 0),
      name: 'Bash',
      outcome: 'completed',
      output: 'testkit-ok\n',
    });
  });

  test('waits for approval in manual mode and runs the tool once approved', async ({ kap, model }) => {
    model.script(bash('echo approved-run'), say('done'));
    const session = await kap.createSession();

    await kap.prompt(session.id, 'run it', { permissionMode: 'manual' });
    const interaction = await kap.waitForInteraction(session.id);
    expect(interaction).toMatchObject({ kind: 'approval', tool_call_id: model.callId(0, 0), request: { tool_name: 'Bash' } });
    expect(model.requests()).toHaveLength(1);

    await kap.answer(session.id, interaction.interaction_id, { kind: 'approval', decision: 'approved' });
    await kap.waitIdle(session.id);
    expect(model.request(1).view.messages.at(-1)).toMatchObject({ role: 'tool', text: 'approved-run\n' });
  });

  test('tells the model when the user rejects a tool call', async ({ kap, model }) => {
    model.script(bash('echo never'), say('understood'));
    const session = await kap.createSession();

    await kap.prompt(session.id, 'run it', { permissionMode: 'manual' });
    const answered: string[] = [];
    await kap.waitIdle(session.id, {
      onInteraction: async (interaction) => {
        answered.push(interaction.kind);
        await kap.answer(session.id, interaction.interaction_id, { kind: 'approval', decision: 'rejected', feedback: 'not now' });
      },
    });

    expect(answered).toEqual(['approval']);
    const result = model.request(1).view.messages.at(-1);
    expect(result?.role).toBe('tool');
    expect(result?.text).not.toContain('never\n');
    expect(result?.text).toContain('not now');
  });

  test('queues a prompt sent while the model is still replying', async ({ kap, model }) => {
    model.script(held('first-reply', say('first answer')), say('second answer'));
    const session = await kap.createSession();

    await kap.prompt(session.id, 'one');
    await model.hold('first-reply').reached();
    const queued = await kap.prompt(session.id, 'two');
    expect(queued.status).toBe('queued');
    model.hold('first-reply').release();
    await kap.waitIdle(session.id);

    expect(model.request(1)).toMatchObject({ firstUserText: 'one', userTextsSinceReply: ['two'] });
    const turns = await kap.turns(session.id);
    expect(turns.map((turn) => turn.items.filter((item) => item.type === 'assistant_message').map((item) => item['text']))).toEqual([
      ['first answer'],
      ['second answer'],
    ]);
  });

  test('cancels a turn while the model request is in flight', async ({ kap, model }) => {
    model.script(held('slow', say('never sent')));
    const session = await kap.createSession();

    await kap.prompt(session.id, 'wait for it');
    await model.hold('slow').reached();
    await expect(kap.cancel(session.id)).resolves.toEqual({ cancelled: true });
    const idle = await kap.waitIdle(session.id);

    expect(idle.last_turn_outcome).toBe('interrupted');
    await expect.poll(() => model.request(0).state).toBe('aborted');
  });

  test('cancels a request while its script is preparing a reply and starts the next turn', async ({ kap, model }) => {
    const entered = deferred<AbortSignal>();
    model.script(async (_request, { signal }) => {
      entered.resolve(signal);
      await once(signal, 'abort');
      return say('late reply');
    }, say('next answer'));
    const session = await kap.createSession();
    await kap.prompt(session.id, 'wait');
    const signal = await entered.promise;
    expect(signal).toBeInstanceOf(AbortSignal);
    const aborted = once(signal, 'abort');
    await expect(kap.cancel(session.id)).resolves.toEqual({ cancelled: true });
    await aborted;
    expect((await kap.waitIdle(session.id)).last_turn_outcome).toBe('interrupted');
    await expect.poll(() => model.request(0).state).toBe('aborted');
    expect(model.request(0).step).toBeNull();

    await kap.prompt(session.id, 'continue');
    await kap.waitIdle(session.id);
    const [interrupted, next] = await kap.turns(session.id);
    expect(interrupted?.items.filter((item) => item.type === 'assistant_message')).toEqual([]);
    expect(next?.items.at(-1)).toMatchObject({ type: 'assistant_message', text: 'next answer' });
  });

  test('steering after a visible chunk aborts the active model stream', async ({ kap, model }) => {
    const entered = deferred<AbortSignal>();
    model.script((_request, { signal }) => {
      entered.resolve(signal);
      return held('after-text', say(['partial answer', 'discarded text']), 1);
    }, say('answer after steering'));
    const session = await kap.createSession();
    const socket = await kap.connect();
    await socket.subscribe(session.id);
    await kap.prompt(session.id, 'initial prompt');
    await model.hold('after-text').reached();
    const firstItem = await socket.waitFor((frame) => frame.type === 'item.started');
    expect(firstItem['item']).toMatchObject({ type: 'assistant_message', text: 'partial answer' });
    const aborted = once(await entered.promise, 'abort');
    await kap.steer(session.id, 'change direction');
    await aborted;
    await kap.waitIdle(session.id);

    expect(model.requests('main').map((request) => request.state)).toEqual(['aborted', 'finished']);
    const turns = await kap.turns(session.id);
    const answers = turns.flatMap((turn) => turn.items.filter((item) => item.type === 'assistant_message').map((item) => item['text']));
    expect(answers).toContain('answer after steering');
    expect(answers.join('')).not.toContain('discarded text');
  });

  test('retries a retryable model error and shows the retry on the turn', async ({ kap, model }) => {
    model.script(httpError(503, { message: 'testkit overload' }), say('recovered'));
    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);

    await kap.prompt(session.id, 'hello');
    await kap.waitIdle(session.id);

    expect(model.requests('main')).toHaveLength(2);
    const retries = socket.frames.filter((frame) => frame.type === 'turn.updated' && frame['retry'] !== undefined);
    expect(retries.length).toBeGreaterThan(0);
    const [turn] = await kap.turns(session.id);
    expect(turn).toMatchObject({ outcome: 'completed' });
    expect(turn).not.toHaveProperty('retry');
    expect(turn?.items.at(-1)).toMatchObject({ type: 'assistant_message', text: 'recovered' });
  });

  test('fails the turn on a model error that cannot be retried', async ({ kap, model }) => {
    model.script(httpError(400, { message: 'testkit rejects this request' }));
    const session = await kap.createSession();

    await kap.prompt(session.id, 'hello');
    const idle = await kap.waitIdle(session.id);

    expect(idle.last_turn_outcome).toBe('failed');
    expect(model.requests()).toHaveLength(1);
    const [turn] = await kap.turns(session.id);
    expect(turn).toMatchObject({ outcome: 'failed' });
    expect(JSON.stringify(turn?.['error'])).toContain('testkit rejects this request');
  });

  test('keeps the conversation across a server restart', async ({ kap, model }) => {
    model.script(say('first answer'), say('second answer'));
    const session = await kap.createSession();
    await kap.prompt(session.id, 'one');
    await kap.waitIdle(session.id);

    await kap.restart();
    expect(await kap.turns(session.id)).toHaveLength(1);
    await kap.prompt(session.id, 'two');
    await kap.waitIdle(session.id);

    const history = model.request(1).view.messages.filter((message) => !message.text.startsWith('<system-reminder>'));
    expect(history.map((message) => [message.role, message.text])).toEqual([
      ['user', 'one'],
      ['assistant', 'first answer'],
      ['user', 'two'],
    ]);
    expect(await kap.turns(session.id)).toHaveLength(2);
  });

  test('routes subagent requests to their own lane', async ({ kap, model }) => {
    model.script(agent({ prompt: 'inspect the workspace', description: 'scout' }), say('summary done'));
    model.lane('subagent').script(say('subagent findings'));
    const session = await kap.createSession();

    await kap.prompt(session.id, 'delegate it');
    await kap.waitIdle(session.id);

    const [subagentRequest] = model.requests('subagent');
    expect(subagentRequest?.metadata).toMatchObject({ agentRole: 'subagent' });
    expect(subagentRequest?.userTextsSinceReply.join('\n')).toContain('inspect the workspace');
    const toolResult = model.requests('main')[1]?.view.messages.find((message) => message.role === 'tool');
    expect(toolResult?.text).toContain('subagent findings');
  });
});
