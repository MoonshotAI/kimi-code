import { once } from 'node:events';

import { deferred } from '@moonshot-ai/testkit/fixtures';
import type { KapFrame, KapItem, KapSocket, KapTurn, KapTurnsPage } from '@moonshot-ai/testkit/kap';
import { agent, bash, call, held, httpError, say, think, withUsage } from '@moonshot-ai/testkit/model';
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

  test('keeps streamed item ids in the persisted turn and reports the agent idle only after the turn ends', async ({ kap, model }) => {
    model.script(held('second-chunk', withUsage({ input: 10, output: 4 }, say(['hello ', 'world'])), 1));
    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);
    expect(snapshotOf(socket, session.id)).toMatchObject({ type: 'turns', session_id: session.id, agent_id: 'main', turns: [], has_more: false });

    const { prompt_id } = await kap.prompt(session.id, 'say hello');
    await model.hold('second-chunk').reached();
    await socket.waitFor((frame) => frame.type === 'item.started' && itemOf(frame)?.type === 'assistant_message');
    model.hold('second-chunk').release();
    await kap.waitIdle(session.id);
    const turnEnd = await socket.waitFor((frame) => isMainTurnEnd(frame, session.id));

    const turns = await kap.turns(session.id);
    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn).toMatchObject({ ordinal: 0, turn_number: 0, kind: 'agent', status: 'ended', outcome: 'completed' });
    expect(turn?.turn_id).toMatch(/^t_[0-9a-f]{12}$/);
    expect(turn).not.toHaveProperty('end_reason');
    expect(turn?.['ended_at']).toEqual(expect.any(String));
    const steps = turn?.['steps'] as ReadonlyArray<Readonly<Record<string, unknown>>> | undefined;
    expect(steps).toEqual([
      expect.objectContaining({ index: 1, outcome: 'completed', usage: expect.objectContaining({ input_other: expect.any(Number), output: 4 }) }),
    ]);
    expect(turn?.['usage']).toEqual(steps?.[0]?.['usage']);
    expect(turn?.items[0]).toMatchObject({
      type: 'user_message',
      placement: 'opener',
      prompt_ids: [prompt_id],
      origin: { kind: 'user' },
      text: 'say hello',
      attachments: [],
      skills: [],
    });
    const answer = turn?.items.find((item) => item.type === 'assistant_message');
    expect(answer).toMatchObject({ status: 'ended', outcome: 'completed', text: 'hello world' });
    const frames = socket.conversation(session.id);
    expect(frames.some((frame) => frame.type === 'item.started' && itemOf(frame)?.item_id === answer?.item_id)).toBe(true);
    expect(frames.some((frame) => frame.type === 'item.delta' && frame['item_id'] === answer?.item_id && frame['field'] === 'text')).toBe(true);
    expect(frames.filter((frame) => frame.type === 'turn.updated').map((frame) => (frame['step'] as { readonly index?: number } | undefined)?.index)).toEqual([1]);
    expect(socket.turns(session.id)).toEqual(turns);

    const running = await socket.waitFor((frame) => isMainAgentFrame(frame, session.id) && frame['status'] === 'running');
    const idle = await socket.waitFor((frame) => isMainAgentFrame(frame, session.id) && frame['status'] === 'idle', {
      after: socket.frames.indexOf(running) + 1,
    });
    expect(socket.frames.indexOf(idle)).toBeGreaterThan(socket.frames.indexOf(turnEnd));
    const agentFrames = socket.frames.filter((frame) => isMainAgentFrame(frame, session.id));
    expect(agentFrames.every((frame) => frame['compacting'] === false)).toBe(true);
    for (const field of ['turn_number', 'prompt_id', 'retry']) {
      expect(agentFrames.filter((frame) => field in frame)).toEqual([]);
    }
  });

  test('shows a client that subscribes mid-turn the running turn and a running agent', async ({ kap, model }) => {
    model.script(held('slow-answer', say('slow answer')));
    const session = await kap.createSession();
    await kap.prompt(session.id, 'take your time');
    await model.hold('slow-answer').reached();

    const socket = await kap.connect();
    await socket.subscribe(session.id);
    expect(snapshotOf(socket, session.id)?.['turns']).toEqual([expect.objectContaining({ status: 'running', turn_number: 0 })]);
    expect(await socket.waitFor((frame) => isMainAgentFrame(frame, session.id))).toMatchObject({ status: 'running' });
    model.hold('slow-answer').release();
    await kap.waitIdle(session.id);

    await socket.waitFor((frame) => isMainAgentFrame(frame, session.id) && frame['status'] === 'idle');
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id));
    expect(socket.turns(session.id)).toEqual(await kap.turns(session.id));
  });

  test('gives a client that subscribes after a turn the same turns page as REST', async ({ kap, model }) => {
    model.script(bash('echo after-turn'), say('done'));
    const session = await kap.createSession();
    await kap.prompt(session.id, 'run it');
    await kap.waitIdle(session.id);

    const page = await kap.rest.get<KapTurnsPage>(`/api/v1/sessions/${session.id}/agents/main/turns`);
    const socket = await kap.connect();
    await socket.subscribe(session.id);
    const snapshot = snapshotOf(socket, session.id);
    expect(snapshot?.['turns']).toEqual(page.turns);
    expect(snapshot?.['has_more']).toBe(page.has_more);
    expect(page.turns.flatMap((turn) => turn.items).filter((item) => item.type === 'tool_call' && item['name'] === 'Bash')).toEqual([
      expect.objectContaining({ item_id: model.callId(0, 0), status: 'ended' }),
    ]);
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

  test('retries invalid tool arguments without retaining failed attempt output or usage', async ({ kap, model }) => {
    model.script(
      withUsage({ input: 2, output: 1 }, call('Bash', {}, { rawArguments: '{"command":', text: 'I will call Bash' })),
      withUsage({ input: 4, output: 3 }, bash('echo testkit-ok')),
      withUsage({ input: 6, output: 2 }, say('done')),
    );
    const session = await kap.createSession();

    await kap.prompt(session.id, 'run it');
    await kap.waitIdle(session.id);

    expect(model.requests('main')).toHaveLength(3);
    expect(model.request(1).view.system).toContain('not executed');
    const [turn] = await kap.turns(session.id);
    const toolCalls = turn?.items.filter((item) => item.type === 'tool_call') ?? [];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: 'Bash', outcome: 'completed', output: 'testkit-ok\n' });
    const assistantText = turn?.items
      .filter((item) => item.type === 'assistant_message')
      .map((item) => item['text'])
      .join('') ?? '';
    expect(assistantText).not.toContain('I will call Bash');
    expect(assistantText).toContain('done');
    const steps = (turn?.steps ?? []) as readonly { usage?: Record<string, unknown> }[];
    const usages = steps.flatMap((step) => step.usage === undefined ? [] : [step.usage]);
    expect(usages).toMatchObject([
      { input_other: 4, output: 3 },
      { input_other: 6, output: 2 },
    ]);
  });

  test('waits for approval in manual mode, shows it on the tool item and runs the tool once approved', async ({ kap, model }) => {
    model.script(bash('echo approved-run'), say('done'));
    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);

    await kap.prompt(session.id, 'run it', { permissionMode: 'manual' });
    const interaction = await kap.waitForInteraction(session.id);
    const callId = model.callId(0, 0);
    expect(interaction).toMatchObject({ kind: 'approval', tool_call_id: callId, request: { tool_name: 'Bash' } });
    expect(model.requests()).toHaveLength(1);
    await socket.waitFor((frame) => frame.type === 'item.started' && itemOf(frame)?.item_id === callId);

    await kap.answer(session.id, interaction.interaction_id, { kind: 'approval', decision: 'approved' });
    await kap.waitIdle(session.id);
    expect(model.request(1).view.messages.at(-1)).toMatchObject({ role: 'tool', text: 'approved-run\n' });

    const turns = await kap.turns(session.id);
    const tool = turns.flatMap((turn) => turn.items).find((item) => item.type === 'tool_call' && item['name'] === 'Bash');
    expect(tool).toMatchObject({
      item_id: callId,
      status: 'ended',
      outcome: 'completed',
      input: { command: 'echo approved-run' },
      interaction_id: interaction.interaction_id,
    });
    expect(tool).not.toHaveProperty('stage');
    expect(String(tool?.['output'])).toContain('approved-run');
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id));
    const toolFrames = socket.conversation(session.id).filter((frame) => itemOf(frame)?.item_id === callId || frame['item_id'] === callId);
    expect(toolFrames[0]).toMatchObject({ type: 'item.started', item: { stage: 'input', name: 'Bash' } });
    expect(toolFrames).toContainEqual(
      expect.objectContaining({
        type: 'item.updated',
        set: expect.objectContaining({ stage: 'awaiting_approval', interaction_id: interaction.interaction_id }),
      }),
    );
    expect(toolFrames.filter((frame) => frame.type === 'item.ended')).toHaveLength(1);
    expect(socket.turns(session.id)).toEqual(turns);
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

  test('queues a prompt sent while the model is still replying and runs it as its own turn', async ({ kap, model }) => {
    model.script(held('first-reply', say('first answer')), say('second answer'));
    const session = await kap.createSession();

    const first = await kap.prompt(session.id, 'one');
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
    expect(turns.map((turn) => [turn['status'], turn.items[0]?.['prompt_ids']])).toEqual([
      ['ended', [first.prompt_id]],
      ['ended', [queued.prompt_id]],
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

  test('undoes a steered turn on REST and WebSocket and gives the resent prompt the same ordinal', async ({ kap, model }) => {
    model.script(held('original-answer', say('answer before steer')), say('answer after steer'), say('answer after steer'));
    const session = await kap.createSession();
    await kap.prompt(session.id, 'original request');
    await model.hold('original-answer').reached();
    const socket = await kap.connect();
    await socket.subscribe(session.id);

    const steer = await kap.prompt(session.id, 'steered request');
    await kap.rest.post(`/api/v1/sessions/${session.id}/prompts:steer`, { prompt_ids: [steer.prompt_id] });
    await kap.waitIdle(session.id);
    const before = await kap.turns(session.id);
    expect(before).toHaveLength(2);
    expect(JSON.stringify(before[1])).toContain('answer after steer');
    const steered = before[1]?.items.find((item) => item.type === 'user_message' && item['placement'] === 'opener');
    expect(steered?.['prompt_ids']).toContain(steer.prompt_id);
    const turnIds = before.map((turn) => turn.turn_id);
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id) && turnOf(frame)?.turn_id === turnIds[1]);
    expect(socket.turns(session.id)).toEqual(before);

    const snapshots = socket.conversation(session.id).filter((frame) => frame.type === 'turns').length;
    expect((await kap.undo(session.id, before[0]!.turn_id)).removed_turn_ids).toEqual(turnIds);
    expect(await kap.turns(session.id)).toEqual([]);
    const removed = await socket.waitFor((frame) => frame.type === 'turns.removed' && frame['session_id'] === session.id);
    expect(removed['turn_ids']).toEqual(turnIds);
    expect(socket.conversation(session.id).filter((frame) => frame.type === 'turns')).toHaveLength(snapshots);
    expect(socket.turns(session.id)).toEqual([]);
    const reconnected = await kap.connect();
    await reconnected.subscribe(session.id);
    expect(snapshotOf(reconnected, session.id)?.['turns']).toEqual([]);
    await reconnected.close();

    await kap.prompt(session.id, 'steered request');
    await kap.waitIdle(session.id);
    const resent = await kap.turns(session.id);
    expect(resent.map((turn) => turn.items[0]?.['text'])).toEqual(['steered request']);
    expect(resent[0]?.ordinal).toBe(before[0]?.ordinal);
    expect(resent[0]?.turn_id).not.toBe(before[0]?.turn_id);
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id) && turnOf(frame)?.turn_id === resent[0]?.turn_id);
    expect(socket.turns(session.id)).toEqual(resent);

    await kap.restart();
    expect(await kap.turns(session.id)).toEqual(resent);
    await kap.undo(session.id, resent[0]!.turn_id);
    expect(await kap.turns(session.id)).toEqual([]);
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

  test('reports a background subagent as a task and starts a notification turn when it completes', async ({ kap, model }) => {
    model.script(agent({ prompt: 'bg-answer-42', description: 'bg ans', run_in_background: true }), say('noted'), say('noted'));
    model.lane('subagent').script(held('background-answer', say('42')));
    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);

    await kap.prompt(session.id, 'spawn one background agent');
    await model.hold('background-answer').reached();
    const task = await socket.waitFor((frame) => frame.type === 'task' && frame['kind'] === 'subagent' && frame['status'] === 'running');
    expect(task).toMatchObject({ session_id: session.id, agent_id: 'main', status: 'running', phase: 'working', detached: true });
    expect(task['child_agent_id']).toEqual(expect.any(String));
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id));
    model.hold('background-answer').release();

    await socket.waitFor((frame) => frame.type === 'task' && frame['task_id'] === task['task_id'] && frame['outcome'] === 'completed');
    await kap.waitIdle(session.id);
    const turns = await kap.turns(session.id);
    const notification = turns.find((turn) => turn.items[0]?.type === 'notification')?.items[0];
    expect(notification).toMatchObject({
      type: 'notification',
      status: 'ended',
      notification_type: 'task.completed',
      severity: 'info',
      source: { kind: 'background_task', id: task['task_id'] },
      task_id: task['task_id'],
      agent_id: task['child_agent_id'],
    });
    expect(notification?.['title']).toEqual(expect.any(String));
    expect(notification?.['title']).not.toBe('');
    expect(JSON.stringify(notification)).not.toContain('<notification');
    const agentTool = turns.flatMap((turn) => turn.items).find((item) => item.type === 'tool_call' && item['name'] === 'Agent');
    expect(agentTool?.['agent_refs']).toEqual([expect.objectContaining({ agent_id: task['child_agent_id'], role: 'child' })]);
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id) && turnOf(frame)?.turn_id === turns.at(-1)?.turn_id);
    expect(socket.turns(session.id)).toEqual(turns);
  });
});

function snapshotOf(socket: KapSocket, sessionId: string): KapFrame | undefined {
  return socket.conversation(sessionId).find((frame) => frame.type === 'turns');
}

function itemOf(frame: KapFrame): KapItem | undefined {
  return frame['item'] as KapItem | undefined;
}

function turnOf(frame: KapFrame): KapTurn | undefined {
  return frame['turn'] as KapTurn | undefined;
}

function isMainAgentFrame(frame: KapFrame, sessionId: string): boolean {
  return frame.type === 'agent' && frame['session_id'] === sessionId && frame['agent_id'] === 'main';
}

function isMainTurnEnd(frame: KapFrame, sessionId: string): boolean {
  return frame.type === 'turn.ended' && frame['session_id'] === sessionId && frame['agent_id'] === 'main';
}
