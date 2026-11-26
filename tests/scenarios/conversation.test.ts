import { once } from 'node:events';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { bashPathOf, deferred, solidPng } from '@moonshot-ai/testkit/fixtures';
import type { KapFrame, KapItem, KapSocket, KapTurn, KapTurnsPage } from '@moonshot-ai/testkit/kap';
import { agent, bash, call, fakeModelConfig, held, httpError, say, think, todoList, withUsage } from '@moonshot-ai/testkit/model';
import { test as base, describe, expect } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const test = base.extend<ScenarioFixtures>(scenarioFixtures());
const visionTest = base.extend<ScenarioFixtures>(
  scenarioFixtures({
    provider: 'openai',
    config: {
      models: {
        testkit: {
          provider: 'testkit',
          model: 'testkit-model',
          maxContextSize: 262_144,
          capabilities: ['thinking', 'image_in'],
        },
      },
    },
  }),
);

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
    expect(turn).toMatchObject({ ordinal: 0, turn_number: 0, kind: 'agent', status: 'ended', outcome: 'completed', continuation: 'none' });
    expect(turnOf(turnEnd)).toMatchObject({ continuation: 'none' });
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
      text: expect.stringMatching(/^Wall time: \d+\.\d{3} seconds\ntestkit-ok\n$/),
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

    model.expectCacheBreak('the retry drops the trailing argument correction, which only costs that message', { at: 'history' });
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
    const steps = (turn?.['steps'] ?? []) as readonly { usage?: Record<string, unknown> }[];
    const usages = steps.flatMap((step) => step.usage === undefined ? [] : [step.usage]);
    expect(usages).toMatchObject([
      { input_other: 4, output: 3 },
      { input_other: 6, output: 2 },
    ]);
  });

  test('runs the lazily created main agent of a session started in a repository subdirectory in that directory', async ({ kap, model }) => {
    const repository = join(kap.home.workspace, 'app');
    const subdirectory = join(repository, 'src');
    await mkdir(join(repository, '.git'), { recursive: true });
    await writeFile(join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(subdirectory);
    model.script(bash('pwd -P'), say('done'));
    const atRoot = await kap.createSession({ cwd: repository });
    const pinned = await kap.createSession({ cwd: subdirectory });

    await kap.prompt(pinned.id, 'where am I');
    await kap.waitIdle(pinned.id);

    expect(pinned.workspace_id).toBe(atRoot.workspace_id);
    const tool = model.request(1).view.messages.find((message) => message.role === 'tool');
    expect(tool?.callId).toBe(model.callId(0, 0));
    expect(tool?.text.replace(/^Wall time: \d+\.\d{3} seconds\n/, '')).toBe(`${bashPathOf(await realpath(subdirectory))}\n`);
  });

  test('waits for approval in manual mode, shows it on the tool item and runs the tool once approved', async ({ kap, model }) => {
    model.script(bash('printf approved-run'), say('done'));
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
    expect(model.request(1).view.messages.at(-1)).toMatchObject({
      role: 'tool',
      text: expect.stringMatching(/^Wall time: \d+\.\d{3} seconds\napproved-run$/),
    });

    const turns = await kap.turns(session.id);
    const tool = turns.flatMap((turn) => turn.items).find((item) => item.type === 'tool_call' && item['name'] === 'Bash');
    expect(tool).toMatchObject({
      item_id: callId,
      status: 'ended',
      outcome: 'completed',
      input: { command: 'printf approved-run' },
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
    model.script(bash('printf never'), say('understood'));
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
    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);

    const first = await kap.prompt(session.id, 'one');
    await model.hold('first-reply').reached();
    const queued = await kap.prompt(session.id, 'two');
    expect(queued.status).toBe('queued');
    model.hold('first-reply').release();
    await kap.waitIdle(session.id);
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id) && turnOf(frame)?.['continuation'] === 'none');

    expect(model.request(1)).toMatchObject({ firstUserText: 'one', userTextsSinceReply: ['two'] });
    const turns = await kap.turns(session.id);
    expect(turns.map((turn) => turn['continuation'])).toEqual(['turn', 'none']);
    expect(
      socket.conversation(session.id)
        .filter((frame) => isMainTurnEnd(frame, session.id))
        .map((frame) => turnOf(frame)?.['continuation']),
    ).toEqual(['turn', 'none']);
    expect(turns.map((turn) => turn.items.filter((item) => item.type === 'assistant_message').map((item) => item['text']))).toEqual([
      ['first answer'],
      ['second answer'],
    ]);
    expect(turns.map((turn) => [turn['status'], turn.items[0]?.['prompt_ids']])).toEqual([
      ['ended', [first.prompt_id]],
      ['ended', [queued.prompt_id]],
    ]);
  });

  test('cancels a turn while the model request is in flight and has nothing to cancel once idle', async ({ kap, model }) => {
    model.script(held('slow', say('never sent')));
    const socket = await kap.connect();
    const session = await kap.createSession();
    expect(session).toMatchObject({ cwd: kap.home.workspace, activity: 'idle' });
    await socket.subscribe(session.id);

    await kap.prompt(session.id, 'wait for it');
    await model.hold('slow').reached();
    const started = await socket.waitFor((frame) => frame.type === 'turn.started' && frame['session_id'] === session.id);
    const turnId = turnOf(started)?.turn_id;
    await expect(kap.cancel(session.id)).resolves.toEqual({ cancelled: true });
    const idle = await kap.waitIdle(session.id);

    expect(idle.last_turn_outcome).toBe('interrupted');
    await expect.poll(() => model.request(0).state).toBe('aborted');
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id) && turnOf(frame)?.turn_id === turnId);
    expect(socket.turns(session.id).find((turn) => turn.turn_id === turnId)).toMatchObject({
      status: 'ended',
      outcome: 'interrupted',
      end_reason: 'user_cancelled',
    });
    await expect(kap.cancel(session.id)).resolves.toEqual({ cancelled: false });
    expect(await kap.session(session.id)).toMatchObject({ activity: 'idle', last_turn_outcome: 'interrupted' });
  });

  test('keeps a background command running on cancel until the client also asks to stop background work, then tells the model it was stopped', async ({ kap, model }) => {
    model.script(bash({ command: 'sleep 10', description: 'long sleep', run_in_background: true }), say('started it'), say('noted the stop'));
    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);

    await kap.prompt(session.id, 'start a long command in the background');
    const task = await socket.waitFor((frame) => frame.type === 'task' && frame['status'] === 'running' && frame['detached'] === true);
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id));
    const lastTaskFrame = () => socket.frames.filter((frame) => frame.type === 'task' && frame['task_id'] === task['task_id']).at(-1);

    await expect(kap.cancel(session.id)).resolves.toEqual({ cancelled: false });
    expect(lastTaskFrame()?.['status']).toBe('running');
    expect(await kap.session(session.id)).toMatchObject({ activity: 'background' });
    const beforeStop = socket.mark();
    await expect(kap.cancel(session.id, { includeBackground: true })).resolves.toEqual({ cancelled: true });
    await socket.waitFor((frame) => frame.type === 'task' && frame['task_id'] === task['task_id'] && frame['status'] === 'ended');
    expect(lastTaskFrame()?.['outcome']).toBe('killed');
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id), { after: beforeStop });
    const [, notified] = await kap.turns(session.id);
    expect(notified?.items.map((item) => item.type)).toEqual(['notification', 'assistant_message']);
    expect(notified?.items[0]).toMatchObject({
      type: 'notification',
      notification_type: 'task.killed',
      source: { kind: 'background_task', id: task['task_id'] },
      task_id: task['task_id'],
    });
  });

  test('streams background task output to task.watch by byte offset, resumes from since_offset and replays it once the task ended', async ({ kap, model }) => {
    const ready = '  VITE ready\n';
    const local = '  ➜  Local: http://localhost:5173/\n';
    const hmr = '4:42:10 PM [vite] hmr update /src/App.vue\n';
    const waitForFile = (name: string) => `until [ -e ${name} ]; do sleep 0.05; done`;
    model.script(
      bash({
        command: [printLine(ready), waitForFile('local.go'), printLine(local), waitForFile('hmr.go'), printLine(hmr), 'sleep 30'].join('; '),
        description: 'npm run dev',
        run_in_background: true,
      }),
      say('dev server started'),
      say('noted the stop'),
    );
    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);
    const watch = (watcher: KapSocket, agentId: string, taskId: string, sinceOffset?: number) =>
      watcher.command({ type: 'task.watch', session_id: session.id, agent_id: agentId, task_id: taskId, ...(sinceOffset === undefined ? {} : { since_offset: sinceOffset }) });
    const nextOutput = (watcher: KapSocket, taskId: string, after: number) =>
      watcher.waitFor((frame) => isTaskOutput(frame, taskId) && frame['text'] !== '', { after });
    const outputsBefore = (watcher: KapSocket, taskId: string, after: number, offset: number) =>
      watcher.frames.slice(after).filter((frame) => isTaskOutput(frame, taskId) && Number(frame['offset']) < offset);

    await kap.prompt(session.id, 'start the dev server');
    const task = await socket.waitFor((frame) => frame.type === 'task' && frame['agent_id'] === 'main' && frame['status'] === 'running' && frame['detached'] === true);
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id));
    const taskId = String(task['task_id']);

    const first = await kap.connect();
    let after = first.mark();
    await watch(first, 'main', taskId);
    expect(await nextOutput(first, taskId, after)).toMatchObject({ session_id: session.id, agent_id: 'main', task_id: taskId, offset: 0, text: ready });
    after = first.mark();
    await writeFile(join(kap.home.workspace, 'local.go'), '');
    expect(await nextOutput(first, taskId, after)).toMatchObject({ offset: Buffer.byteLength(ready), text: local });
    await first.close();

    await writeFile(join(kap.home.workspace, 'hmr.go'), '');
    const since = Buffer.byteLength(ready) + Buffer.byteLength(local);
    const second = await kap.connect();
    after = second.mark();
    await watch(second, 'main', taskId, since);
    expect(await nextOutput(second, taskId, after)).toMatchObject({ offset: since, text: hmr });
    expect(outputsBefore(second, taskId, after, since)).toEqual([]);
    await expect(watch(second, 'main', 'bash-00000000')).rejects.toMatchObject({ response: { code: 40406 } });
    await second.close();

    const beforeStop = socket.mark();
    await expect(kap.cancel(session.id, { includeBackground: true })).resolves.toEqual({ cancelled: true });
    await socket.waitFor((frame) => frame.type === 'task' && frame['task_id'] === taskId && frame['status'] === 'ended');
    const third = await kap.connect();
    after = third.mark();
    expect(await watch(third, 'main', taskId)).toMatchObject({
      code: 0,
      task: { task_id: taskId, kind: 'shell', status: 'ended', outcome: 'killed', description: 'npm run dev' },
    });
    expect(await nextOutput(third, taskId, after)).toMatchObject({ offset: 0, text: `${ready}${local}${hmr}` });
    await third.close();
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id), { after: beforeStop });
  });

  test('lets task.watch read a task only through the agent that owns it', async ({ kap, model }) => {
    const testRun = ' RUN  v3.2.4\n';
    model.script(agent({ prompt: 'run the tests in watch mode', description: 'tests' }), say('tests are running'));
    model.lane('subagent').script(
      bash({ command: `${printLine(testRun)}; sleep 30`, description: 'pnpm test --watch', run_in_background: true }),
      held('child-reply', say('watching')),
      say('the test run was stopped'),
    );
    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);

    await kap.prompt(session.id, 'run the tests in the background');
    await model.hold('child-reply').reached();
    const delegation = (await kap.turns(session.id)).flatMap((turn) => turn.items).find((item) => item.type === 'tool_call' && item['name'] === 'Agent');
    const childId = childAgentIdOf(delegation);
    await socket.subscribe(session.id, { agentIds: [childId] });
    const childTasks = (await socket.waitFor((frame) => frame.type === 'task.list' && frame['agent_id'] === childId))['tasks'] as readonly { readonly task_id: string; readonly status: string }[];
    expect(childTasks).toEqual([expect.objectContaining({ status: 'running' })]);
    const childTaskId = childTasks[0]!.task_id;

    const watcher = await kap.connect();
    const watch = (agentId: string) => watcher.command({ type: 'task.watch', session_id: session.id, agent_id: agentId, task_id: childTaskId });
    await expect(watch('main')).rejects.toMatchObject({ response: { code: 40406 } });
    const after = watcher.mark();
    await watch(childId);
    expect(await watcher.waitFor((frame) => isTaskOutput(frame, childTaskId) && frame['text'] !== '', { after })).toMatchObject({
      session_id: session.id,
      agent_id: childId,
      task_id: childTaskId,
      offset: 0,
      text: testRun,
    });
    await watcher.close();

    model.hold('child-reply').release();
    await socket.waitFor((frame) => frame.type === 'turn.ended' && frame['session_id'] === session.id && frame['agent_id'] === childId);
    await expect(kap.cancel(session.id, { agentId: childId, includeBackground: true })).resolves.toEqual({ cancelled: true });
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id));
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
    model.expectCacheBreak('undo rewrites the history', { at: 'history' });
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

  test('continues an interrupted or failed turn and refuses when nothing is left to continue or a turn is running', async ({ kap, model }) => {
    model.script(
      held('interrupted-answer', say(['half-1 ', 'half-2']), 1),
      say('resumed reply'),
      httpError(400, { message: 'synthetic upstream error' }),
      say('resumed reply'),
      httpError(400, { message: 'synthetic upstream error' }),
      say('resumed reply'),
    );
    model.lane('compaction').script(say('compacted summary'));
    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);
    const resume = () => kap.rest.post<{ readonly continued: boolean }>(`/api/v1/sessions/${session.id}:continue`, {});
    const lastTurnAfter = async <T>(action: () => Promise<T>): Promise<{ readonly result: T; readonly turn: KapTurn | undefined }> => {
      const mark = socket.mark();
      const result = await action();
      await socket.waitFor((frame) => isMainTurnEnd(frame, session.id), { after: mark });
      return { result, turn: socket.turns(session.id).at(-1) };
    };

    await expect(resume()).rejects.toMatchObject({ code: 40940 });
    await kap.prompt(session.id, 'interrupt me');
    await model.hold('interrupted-answer').reached();
    await expect(resume()).rejects.toMatchObject({ code: 40901 });
    const interrupted = await lastTurnAfter(() => kap.cancel(session.id));
    expect(interrupted.turn).toMatchObject({ status: 'ended', outcome: 'interrupted' });

    const continued = await lastTurnAfter(resume);
    expect(continued.result).toEqual({ continued: true });
    expect(socket.turns(session.id).length).toBeGreaterThanOrEqual(2);
    expect(continued.turn?.['outcome']).toBe('completed');
    expect(continued.turn?.items.filter((item) => item.type === 'user_message')).toEqual([]);
    expect(continued.turn?.items.find((item) => item.type === 'assistant_message')?.['text']).toBe('resumed reply');
    await expect(resume()).rejects.toMatchObject({ code: 40940 });

    expect((await lastTurnAfter(() => kap.prompt(session.id, 'trigger failure'))).turn).toMatchObject({ status: 'ended', outcome: 'failed' });
    const afterFailure = await lastTurnAfter(resume);
    expect(afterFailure.result).toEqual({ continued: true });
    expect(afterFailure.turn).toMatchObject({ status: 'ended', outcome: 'completed' });
    model.expectCacheBreak('undo rewrites the history', { at: 'history' });
    await kap.undo(session.id, socket.turns(session.id)[0]!.turn_id);
    await expect(resume()).rejects.toMatchObject({ code: 40940 });

    expect((await lastTurnAfter(() => kap.prompt(session.id, 'trigger failure before compact'))).turn).toMatchObject({
      status: 'ended',
      outcome: 'failed',
    });
    expect((await lastTurnAfter(() => kap.compact(session.id))).turn).toMatchObject({ kind: 'system', outcome: 'completed' });
    const afterCompaction = await lastTurnAfter(resume);
    expect(afterCompaction.result).toEqual({ continued: true });
    expect(afterCompaction.turn).toMatchObject({ kind: 'agent', status: 'ended', outcome: 'completed' });
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
    expect(turns.map((turn) => turn['continuation'])).toEqual(['background', 'none']);
    expect(
      socket.conversation(session.id)
        .filter((frame) => isMainTurnEnd(frame, session.id))
        .map((frame) => turnOf(frame)?.['continuation']),
    ).toEqual(['background', 'none']);
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

  test('resumes a foreground subagent with its prior context after a server restart', async ({ kap, model }) => {
    model.script(agent({ prompt: 'remember the token quartz-7731 and reply with ok', description: 'child' }), say('noted'));
    model.lane('subagent').script(say('ok, remembered'));
    const session = await kap.createSession();
    const agentCalls = async () => (await kap.turns(session.id)).flatMap((turn) => turn.items).filter((item) => item.type === 'tool_call' && item['name'] === 'Agent');

    await kap.prompt(session.id, 'spawn the child');
    await kap.waitIdle(session.id);
    const [spawn] = await agentCalls();
    expect(spawn?.['agent_refs']).toEqual([expect.objectContaining({ agent_id: expect.any(String), role: 'child' })]);
    const childId = childAgentIdOf(spawn);

    await kap.restart();
    model.script(agent({ prompt: 'recall the token', description: 'child again', resume: childId }), say('the child remembered'));
    model.lane('subagent').script(say('the token is quartz-7731'));
    await kap.prompt(session.id, 'resume the child');
    await kap.waitIdle(session.id);

    const resumed = model.requests('subagent')[1];
    expect(resumed?.texts('user').join('\n')).toContain('remember the token quartz-7731 and reply with ok');
    expect(resumed?.texts('assistant')).toContain('ok, remembered');
    expect(resumed?.userTextsSinceReply.join('\n')).toContain('recall the token');
    const calls = await agentCalls();
    expect(calls).toHaveLength(2);
    expect(String(calls[1]?.['output'])).toContain(`agent_id: ${childId}`);
    expect(String(calls[1]?.['output'])).toContain('the token is quartz-7731');
    const childTurns = await kap.turns(session.id, childId);
    expect(childTurns.map((turn) => turn.items[0]?.['text'])).toEqual(['remember the token quartz-7731 and reply with ok', 'recall the token']);
  });

  test('sends a new subscriber the idle main agent and its empty todo list, then pushes TodoList writes', async ({ kap, model }) => {
    model.script(todoList([{ title: 'write tests', status: 'in_progress' }, { title: 'ship', status: 'pending' }]), say('planned'));
    const socket = await kap.connect();
    const session = await kap.createSession();
    const isTodoFrame = (frame: KapFrame) => frame.type === 'todo' && frame['session_id'] === session.id && frame['agent_id'] === 'main';
    await socket.subscribe(session.id);
    expect(await socket.waitFor((frame) => isMainAgentFrame(frame, session.id))).toMatchObject({ type: 'agent', session_id: session.id, status: 'idle' });
    expect(await socket.waitFor(isTodoFrame)).toMatchObject({ type: 'todo', session_id: session.id, items: [] });

    await kap.prompt(session.id, 'plan the work');
    await kap.waitIdle(session.id);
    await socket.waitFor((frame) => isTodoFrame(frame) && (frame['items'] as readonly unknown[]).length > 0);
    expect(socket.frames.filter(isTodoFrame).at(-1)?.['items']).toEqual([
      { title: 'write tests', status: 'in_progress' },
      { title: 'ship', status: 'pending' },
    ]);
  });

  test('orders agent settings across the profile response and agent frames with profile_revision', async ({ kap }) => {
    const session = await kap.createSession();
    const socket = await kap.connect();
    await socket.subscribe(session.id);
    const initial = await socket.waitFor((frame) => isMainAgentFrame(frame, session.id));
    const initialRevision = initial['profile_revision'];
    expect(initial['permission_mode']).toBe('yolo');
    expect(initialRevision).toEqual(expect.any(Number));

    const profilePath = `/api/v1/sessions/${session.id}/profile`;
    const updated = await kap.rest.post<{ readonly agent: Readonly<Record<string, unknown>> }>(profilePath, {
      agent_config: { permission_mode: 'manual' },
    });
    expect(updated.agent['permission_mode']).toBe('manual');
    expect(updated.agent['profile_revision']).toBeGreaterThan(initialRevision as number);
    const pushed = await socket.waitFor((frame) => isMainAgentFrame(frame, session.id) && frame['permission_mode'] === 'manual');
    expect(pushed['profile_revision']).toBe(updated.agent['profile_revision']);

    const renamed = await kap.rest.post<{ readonly agent: Readonly<Record<string, unknown>> }>(profilePath, { title: 'renamed' });
    expect(renamed.agent['profile_revision']).toBe(updated.agent['profile_revision']);
  });

  test('closes a side agent with an ended agent frame and refuses to close the main agent', async ({ kap }) => {
    const session = await kap.createSession();
    const side = await kap.rest.post<{ readonly agent_id: string }>(`/api/v1/sessions/${session.id}:btw`, {});
    const sideAgent = `/api/v1/sessions/${session.id}/agents/${encodeURIComponent(side.agent_id)}`;
    const isSideAgentFrame = (frame: KapFrame) => frame.type === 'agent' && frame['session_id'] === session.id && frame['agent_id'] === side.agent_id;
    const socket = await kap.connect();
    await socket.subscribe(session.id, { agentIds: [side.agent_id] });
    await socket.waitFor(isSideAgentFrame);

    await expect(kap.rest.post(`/api/v1/sessions/${session.id}/agents/main:close`, {})).rejects.toMatchObject({ code: 40939 });
    expect(await kap.rest.post(`${sideAgent}:close`, {})).toEqual({ closed: true });
    await socket.waitFor((frame) => isSideAgentFrame(frame) && frame['status'] === 'ended');
    expect(socket.frames.filter(isSideAgentFrame).at(-1)).toMatchObject({
      type: 'agent',
      session_id: session.id,
      agent_id: side.agent_id,
      status: 'ended',
      compacting: false,
    });
    await expect(kap.rest.post(`${sideAgent}:close`, {})).rejects.toMatchObject({ code: 40401 });
    await expect(kap.rest.get(`${sideAgent}/turns`)).rejects.toMatchObject({ code: 40401 });
  });

  test('starts a side agent in the permission mode the main agent is using rather than the configured default', async ({ kap, model }) => {
    await kap.writeConfig({ ...fakeModelConfig(model), defaultPermissionMode: 'manual' });
    await kap.restart();
    const session = await kap.createSession();
    await kap.rest.post(`/api/v1/sessions/${session.id}/profile`, { agent_config: { permission_mode: 'yolo' } });
    const side = await kap.rest.post<{ readonly agent_id: string }>(`/api/v1/sessions/${session.id}:btw`, {});
    const socket = await kap.connect();
    await socket.subscribe(session.id, { agentIds: [side.agent_id] });

    const frame = await socket.waitFor((candidate) => candidate.type === 'agent' && candidate['session_id'] === session.id && candidate['agent_id'] === side.agent_id);
    expect(frame['permission_mode']).toBe('yolo');
  });

  visionTest('exposes local session media paths to the model for pasted and steered images without persisting the labels in KAP user messages', async ({ kap, model }) => {
    const png1 = solidPng(1, 1, [0x22, 0x66, 0xcc, 0xff]);
    const png2 = solidPng(1, 1, [0xcc, 0x55, 0x22, 0xff]);
    const entered = deferred<AbortSignal>();
    let firstPath = '';
    let secondPath = '';

    model.script(
      (request, { signal }) => {
        const text = request.texts('user').join('\n');
        firstPath = /<image name="paste-1\.png" path="([^"]+)">/.exec(text)?.[1] ?? '';
        entered.resolve(signal);
        return held('before-steer-image', say(['inspecting', 'discarded']), 1);
      },
      (request) => {
        const text = request.texts('user').join('\n');
        firstPath = /<image name="paste-1\.png" path="([^"]+)">/.exec(text)?.[1] ?? '';
        secondPath = /<image name="steer-2\.png" path="([^"]+)">/.exec(text)?.[1] ?? '';
        const copyScript = [
          'const fs = require("node:fs");',
          `fs.copyFileSync(${JSON.stringify(firstPath)}, "out-1.png");`,
          `fs.copyFileSync(${JSON.stringify(secondPath)}, "out-2.png");`,
        ].join(' ');
        return bash(`node -e ${JSON.stringify(copyScript)}`);
      },
      say('copied both images'),
    );

    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);

    const uploaded1 = await uploadImageFile(kap.origin, kap.token, png1, 'paste-1.png');
    await kap.prompt(session.id, [
      { type: 'text', text: 'copy pasted image' },
      { type: 'image', source: { kind: 'file', file_id: uploaded1.id }, name: 'paste-1.png' },
    ]);
    await model.hold('before-steer-image').reached();
    await socket.waitFor((frame) => frame.type === 'item.started' && itemOf(frame)?.type === 'assistant_message');
    expect(firstPath).not.toBe('');
    expect(model.request(0).rawBody).toContain('image_url');

    const aborted = once(await entered.promise, 'abort');
    const uploaded2 = await uploadImageFile(kap.origin, kap.token, png2, 'steer-2.png');
    await kap.steer(session.id, [
      { type: 'text', text: 'also copy steered image' },
      { type: 'image', source: { kind: 'file', file_id: uploaded2.id }, name: 'steer-2.png' },
    ]);
    await aborted;
    await kap.waitIdle(session.id);
    await socket.waitFor((frame) => isMainTurnEnd(frame, session.id));

    expect(secondPath).not.toBe('');
    expect(model.request(1).rawBody.match(/"type"\s*:\s*"image_url"/g)).toHaveLength(2);
    expect(await readFile(join(session.cwd, 'out-1.png'))).toEqual(png1);
    expect(await readFile(join(session.cwd, 'out-2.png'))).toEqual(png2);

    const turns = await kap.turns(session.id);
    const userItems = turns.flatMap((turn) => turn.items.filter((item) => item.type === 'user_message'));
    expect(JSON.stringify(userItems)).not.toContain(firstPath);
    expect(JSON.stringify(userItems)).not.toContain(secondPath);
    const wsUserItems = socket.frames.filter((frame) => itemOf(frame)?.type === 'user_message');
    expect(JSON.stringify(wsUserItems)).not.toContain(firstPath);
    expect(JSON.stringify(wsUserItems)).not.toContain(secondPath);
  });
});

async function uploadImageFile(
  origin: string,
  token: string,
  bytes: Buffer,
  name: string,
): Promise<{ readonly id: string }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name);
  const res = await fetch(`${origin}/api/v1/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = (await res.json()) as { readonly code: number; readonly data: { readonly id: string } };
  expect(body.code).toBe(0);
  return body.data;
}

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

function isTaskOutput(frame: KapFrame, taskId: string): boolean {
  return frame.type === 'task.output' && frame['task_id'] === taskId;
}

function childAgentIdOf(item: KapItem | undefined): string {
  return String((item?.['agent_refs'] as readonly { readonly agent_id: string }[] | undefined)?.[0]?.agent_id);
}

function printLine(line: string): string {
  return `printf '%s\\n' '${line.trimEnd()}'`;
}
