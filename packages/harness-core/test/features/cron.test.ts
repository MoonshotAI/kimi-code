import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigRef,
  createConfig,
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  UNKNOWN_CAPABILITY,
  useAgent,
  type AgentHandle,
  type ConfigPersist,
  type FeatureSpec,
  type LlmModel,
  type LlmRequester,
  type SessionHandle,
  type SessionStores,
  type ToolMeta,
} from '@moonshot-ai/agent-core';

import {
  CRON_ADD,
  createCron,
  CronRef,
  DEFAULT_CRON_CONFIG,
  type CronFace,
  type CronFiredEvent,
  type CronJobOrigin,
  type CronTask,
} from '#/features/cron/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

type ScriptStep = { text: string } | { toolCall: { name: string; arguments: string } };

let queue: ScriptStep[] = [];
let callSeq = 0;

function createMockRequester(): LlmRequester {
  return {
    generate: async (_config, _content, { onEvent }) => {
      const out = queue.shift() ?? { text: 'done' };
      if ('toolCall' in out) {
        onEvent?.({
          type: 'llm.streaming.part',
          part: {
            type: 'function',
            id: `call-${(callSeq += 1)}`,
            name: out.toolCall.name,
            arguments: out.toolCall.arguments,
          },
        });
      } else {
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: out.text } });
      }
      onEvent?.({
        type: 'llm.streaming.usage',
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      });
      onEvent?.({ type: 'llm.done' });
    },
  };
}

function bindTestLlm(requester: LlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model });
      agent.setRequester(requester);
    },
  });
}

function fakePersist(initial?: string): { saved: string[]; persist: ConfigPersist } {
  const saved: string[] = [];
  let text = initial;
  return {
    saved,
    persist: {
      load: () => Promise.resolve(text),
      save: (value) => {
        saved.push(value);
        text = value;
        return Promise.resolve();
      },
    },
  };
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setupClockDir(): { clockFile: string; setClock: (ms: number) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'harness-cron-'));
  dirs.push(dir);
  const clockFile = join(dir, 'clock.txt');
  return {
    clockFile,
    setClock: (ms) => {
      writeFileSync(clockFile, String(ms));
    },
  };
}

const WALL_ANCHOR = 1_700_000_000_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function minuteAfter(ms: number): number {
  return Math.floor(ms / 60_000) * 60_000 + 60_000;
}

interface CronTestEnv {
  readonly app: ReturnType<typeof createHarness>;
  readonly session: SessionHandle;
  readonly stores: SessionStores;
  readonly cronFeature: FeatureSpec<CronFiredEvent>;
  runTurn(text?: string, agent?: AgentHandle): Promise<void>;
  remount(): Promise<void>;
  dispose(): Promise<void>;
  cron(): CronFace;
  main(): AgentHandle;
}

async function startCronTest(options?: {
  readonly toml?: string;
  readonly env?: Record<string, string | undefined>;
  readonly withConfig?: boolean;
}): Promise<CronTestEnv> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const withConfig = options?.withConfig ?? true;
  const cronFeature = createCron();
  const features: FeatureSpec[] = [
    ...(withConfig
      ? [createConfig({ persist: fakePersist(options?.toml).persist, env: options?.env ?? {} })]
      : []),
    cronFeature,
    bindTestLlm(createMockRequester()),
  ];
  const app = createHarness({ features });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores });
  let main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  await main.ready();
  const runTurn = async (text = 'go', agent?: AgentHandle): Promise<void> => {
    const target = agent ?? main;
    const done = new Promise<void>((resolve) => {
      target.on('turn.done', () => {
        resolve();
      });
    });
    target.submit(createUserMessage(text));
    await done;
    await stores.flush();
  };
  const remount = async (): Promise<void> => {
    await session.close(MAIN_AGENT_ID);
    main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
    await main.ready();
  };
  const dispose = async (): Promise<void> => {
    await app.disposeAsync();
    await stores.dispose();
  };
  return {
    app,
    session,
    stores,
    cronFeature,
    runTurn,
    remount,
    dispose,
    cron: () => main.resolve(CronRef),
    main: () => main,
  };
}

function historyOf(stores: SessionStores, agentId = MAIN_AGENT_ID) {
  return stores.get(agentId)?.getState().history ?? [];
}

function toolResultTexts(stores: SessionStores, agentId = MAIN_AGENT_ID): string[] {
  return historyOf(stores, agentId)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(stores: SessionStores, agentId = MAIN_AGENT_ID): boolean[] {
  return historyOf(stores, agentId)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function cronFireEntries(stores: SessionStores) {
  return historyOf(stores).filter((entry) => entry.meta?.origin?.kind === 'cron_job');
}

function waitTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise<void>((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UUID_PATTERN_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const MANUAL_TICK_TOML = '[cron]\nmanualTick = true\nnoJitter = true\n';

describe('cron feature', () => {
  it('registers the cron config section and applies env bindings', async () => {
    const env = await startCronTest();
    expect(env.app.resolve(ConfigRef).get('cron')).toEqual(DEFAULT_CRON_CONFIG);
    await env.dispose();

    const bound = await startCronTest({
      env: {
        KIMI_DISABLE_CRON: '1',
        KIMI_CRON_NO_JITTER: '1',
        KIMI_CRON_MANUAL_TICK: '1',
        KIMI_CRON_CLOCK: 'file:/tmp/never-exists-clock',
        KIMI_CRON_POLL_INTERVAL_MS: '250',
      },
    });
    expect(bound.app.resolve(ConfigRef).get('cron')).toEqual({
      ...DEFAULT_CRON_CONFIG,
      disabled: true,
      noJitter: true,
      manualTick: true,
      clock: 'file:/tmp/never-exists-clock',
      pollIntervalMs: 250,
    });
    expect(bound.cron().isDisabled()).toBe(true);
    queue = [
      { toolCall: { name: 'CronCreate', arguments: JSON.stringify({ cron: '*/5 * * * *', prompt: 'ping' }) } },
      { text: 'done' },
    ];
    await bound.runTurn();
    expect(toolResultTexts(bound.stores).at(-1)).toBe(
      'Cron scheduling is disabled (KIMI_DISABLE_CRON=1).',
    );
    expect(bound.cron().list()).toEqual([]);
    await bound.dispose();
  });

  it('schedules recurring and one-shot tasks through CronCreate, normalizing whitespace, without a config feature', async () => {
    const env = await startCronTest({ withConfig: false });
    expect(env.cron().isDisabled()).toBe(false);

    queue = [
      { toolCall: { name: 'CronCreate', arguments: JSON.stringify({ cron: '  0\n12\t31  12 *  ', prompt: 'yearly' }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    const created = toolResultTexts(env.stores).at(-1) ?? '';
    const id = created.match(/^id: (\S+)$/m)?.[1] ?? '';
    expect(id).toMatch(UUID_PATTERN);
    expect(created).toContain('cron: 0 12 31 12 *');
    expect(created).toContain('humanSchedule: at 12:00 on day 31 of December');
    expect(created).toContain('recurring: true');
    expect(created).toMatch(/^nextFireAt: \d{4}-\d{2}-\d{2}T12:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/m);

    queue = [
      { toolCall: { name: 'CronCreate', arguments: JSON.stringify({ cron: '30 14 28 2 *', prompt: 'once', recurring: false }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    const oneShot = toolResultTexts(env.stores).at(-1) ?? '';
    expect(oneShot).toContain('humanSchedule: at 14:30 on day 28 of February');
    expect(oneShot).toContain('recurring: false');

    const tasks = env.cron().list();
    expect(tasks.map((task) => [task.cron, task.prompt, task.recurring])).toEqual([
      ['0 12 31 12 *', 'yearly', true],
      ['30 14 28 2 *', 'once', false],
    ]);
    await env.dispose();
  });

  it('rejects invalid expressions, no-fire expressions, oversized prompts, far-future one-shots, and cap overflow', async () => {
    const { clockFile, setClock } = setupClockDir();
    setClock(new Date(2026, 0, 2, 0, 0, 0, 0).getTime());
    const env = await startCronTest({
      toml: `[cron]\nmanualTick = true\nnoJitter = true\nclock = "file:${clockFile}"\n`,
    });
    const lastResult = (): string => toolResultTexts(env.stores).at(-1) ?? '';
    const create = (args: Record<string, unknown>): ScriptStep[] => [
      { toolCall: { name: 'CronCreate', arguments: JSON.stringify(args) } },
      { text: 'done' },
    ];

    queue = create({ cron: 'not a cron', prompt: 'ping' });
    await env.runTurn();
    expect(lastResult()).toContain('Invalid cron expression');
    expect(lastResult()).toContain('exactly 5 fields');

    queue = create({ cron: '0 0 31 2 *', prompt: 'never' });
    await env.runTurn();
    expect(lastResult()).toContain('has no fire within 5 years');

    queue = create({ cron: '*/5 * * * *', prompt: '你'.repeat(3000) });
    await env.runTurn();
    expect(lastResult()).toContain('Prompt exceeds 8192 bytes');

    queue = create({ cron: '0 12 1 1 *', prompt: 'far', recurring: false });
    await env.runTurn();
    expect(lastResult()).toContain('(more than a year out)');

    for (let i = 0; i < 50; i += 1) {
      await env.cron().addTask({ cron: '*/5 * * * *', prompt: `seed-${i}`, recurring: true });
    }
    queue = create({ cron: '*/5 * * * *', prompt: 'overflow' });
    await env.runTurn();
    expect(lastResult()).toBe('Cron job cap reached (max 50 per session).');
    expect(toolResultIsErrors(env.stores)).toEqual([true, true, true, true, true]);
    expect(env.cron().list()).toHaveLength(50);
    await env.dispose();
  });

  it('renders CronList output for empty, populated, stale, malformed, and truncated records', async () => {
    const env = await startCronTest({ toml: MANUAL_TICK_TOML });
    const list = async (): Promise<string> => {
      queue = [{ toolCall: { name: 'CronList', arguments: '{}' } }, { text: 'done' }];
      await env.runTurn();
      return toolResultTexts(env.stores).at(-1) ?? '';
    };

    expect(await list()).toBe('cron_jobs: 0\nNo cron jobs scheduled.');

    await env.cron().addTask({ cron: '*/5 * * * *', prompt: 'first', recurring: true });
    await env.cron().addTask({ cron: '0 12 * * *', prompt: 'second', recurring: false });
    const populated = (await list())
      .replace(UUID_PATTERN_GLOBAL, '<id>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/g, '<iso>');
    expect(populated).toBe(
      [
        'cron_jobs: 2',
        'id: <id>',
        'cron: */5 * * * *',
        'humanSchedule: every 5 minutes',
        'prompt: "first"',
        'nextFireAt: <iso>',
        'recurring: true',
        'ageDays: 0.00',
        'stale: false',
        '---',
        'id: <id>',
        'cron: 0 12 * * *',
        'humanSchedule: at 12:00 every day',
        'prompt: "second"',
        'nextFireAt: <iso>',
        'recurring: false',
        'ageDays: 0.00',
        'stale: false',
      ].join('\n'),
    );

    const now = Date.now();
    const staleTask: CronTask = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      cron: '*/5 * * * *',
      prompt: 'x'.repeat(300),
      createdAt: now - 8 * MS_PER_DAY,
      recurring: true,
    };
    const malformedTask: CronTask = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      cron: 'garbage',
      prompt: 'x',
      createdAt: now,
      recurring: true,
    };
    const store = env.stores.get(MAIN_AGENT_ID);
    await store?.dispatch({ type: CRON_ADD, task: staleTask });
    await store?.dispatch({ type: CRON_ADD, task: malformedTask });
    const output = await list();
    expect(output).toContain('cron_jobs: 4');
    expect(output).toContain('ageDays: 8.00\nstale: true');
    expect(output).toContain('…(truncated)"');
    expect(output).toContain(
      ['cron: garbage', 'humanSchedule: garbage', 'prompt: "x"', 'nextFireAt: null'].join('\n'),
    );
    await env.dispose();
  });

  it('deletes tasks through CronDelete and reports missing or malformed ids', async () => {
    const env = await startCronTest({ toml: MANUAL_TICK_TOML });
    const task = await env.cron().addTask({ cron: '*/5 * * * *', prompt: 'ping', recurring: true });

    queue = [{ toolCall: { name: 'CronDelete', arguments: JSON.stringify({ id: task.id }) } }, { text: 'done' }];
    await env.runTurn();
    expect(toolResultTexts(env.stores).at(-1)).toBe(`Deleted cron job ${task.id}.`);
    expect(env.cron().list()).toEqual([]);

    const missing = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    queue = [{ toolCall: { name: 'CronDelete', arguments: JSON.stringify({ id: missing }) } }, { text: 'done' }];
    await env.runTurn();
    expect(toolResultTexts(env.stores).at(-1)).toBe(`No cron job with id ${missing}.`);
    expect(toolResultIsErrors(env.stores).at(-1)).toBe(true);

    queue = [{ toolCall: { name: 'CronDelete', arguments: JSON.stringify({ id: 'not-a-uuid' }) } }, { text: 'done' }];
    await env.runTurn();
    expect(toolResultTexts(env.stores).at(-1)).toBe(
      'Invalid cron job id "not-a-uuid" — must be a UUID.',
    );
    expect(toolResultIsErrors(env.stores).at(-1)).toBe(true);
    await env.dispose();
  });

  it('delivers due fires with the cron-fire envelope, origin meta, coalescing, cursor advance, and a cron.fired event', async () => {
    const { clockFile, setClock } = setupClockDir();
    setClock(WALL_ANCHOR);
    const env = await startCronTest({
      toml: `[cron]\nmanualTick = true\nnoJitter = true\nclock = "file:${clockFile}"\n`,
    });
    const fired: CronJobOrigin[] = [];
    env.session.on(env.cronFeature, 'cron.fired', (event) => {
      fired.push(event.origin);
    });
    const cron = env.cron();
    const task = await cron.addTask({ cron: '* * * * *', prompt: 'fire me', recurring: true });
    expect(task.createdAt).toBe(WALL_ANCHOR);

    await cron.tick();
    expect(cronFireEntries(env.stores)).toHaveLength(0);

    const firstFire = minuteAfter(WALL_ANCHOR);
    setClock(firstFire + 9 * 60_000);
    const done = waitTurnDone(env.main());
    queue = [{ text: 'cron handled' }];
    await cron.tick();
    await done;
    await env.stores.flush();

    const fires = cronFireEntries(env.stores);
    expect(fires).toHaveLength(1);
    const envelope = extractText(fires[0]!.message);
    expect(envelope).toContain(
      `<cron-fire jobId="${task.id}" cron="* * * * *" recurring="true" coalescedCount="10" stale="false">\n<prompt>\nfire me\n</prompt>\n</cron-fire>`,
    );
    expect(fires[0]!.meta?.origin).toEqual({
      kind: 'cron_job',
      jobId: task.id,
      cron: '* * * * *',
      recurring: true,
      coalescedCount: 10,
      stale: false,
    });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ jobId: task.id, coalescedCount: 10, stale: false });
    expect(cron.getTask(task.id)?.lastFiredAt).toBe(firstFire + 9 * 60_000);
    await env.dispose();
  });

  it('auto-deletes one-shot tasks after their first fire', async () => {
    const { clockFile, setClock } = setupClockDir();
    setClock(WALL_ANCHOR);
    const env = await startCronTest({
      toml: `[cron]\nmanualTick = true\nnoJitter = true\nclock = "file:${clockFile}"\n`,
    });
    const cron = env.cron();
    const task = await cron.addTask({ cron: '* * * * *', prompt: 'once', recurring: false });

    setClock(minuteAfter(WALL_ANCHOR));
    const done = waitTurnDone(env.main());
    queue = [{ text: 'cron handled' }];
    await cron.tick();
    await done;
    await env.stores.flush();

    const fires = cronFireEntries(env.stores);
    expect(fires).toHaveLength(1);
    expect(extractText(fires[0]!.message)).toContain(
      'recurring="false" coalescedCount="1" stale="false"',
    );
    expect(cron.list()).toEqual([]);
    expect(cron.getTask(task.id)).toBeUndefined();
    await env.dispose();
  });

  it('fires a stale recurring task once with stale=true and then deletes it', async () => {
    const { clockFile, setClock } = setupClockDir();
    setClock(WALL_ANCHOR);
    const env = await startCronTest({
      toml: `[cron]\nmanualTick = true\nnoJitter = true\nclock = "file:${clockFile}"\n`,
    });
    const cron = env.cron();
    await cron.addTask({ cron: '0 * * * *', prompt: 'old', recurring: true });

    setClock(WALL_ANCHOR + 8 * MS_PER_DAY);
    const done = waitTurnDone(env.main());
    queue = [{ text: 'cron handled' }];
    await cron.tick();
    await done;
    await env.stores.flush();

    const fires = cronFireEntries(env.stores);
    expect(fires).toHaveLength(1);
    expect(extractText(fires[0]!.message)).toContain('stale="true"');
    expect(cron.list()).toEqual([]);
    await env.dispose();
  });

  it('restores the task table from the journal on remount and resumes firing from the persisted cursor', async () => {
    const { clockFile, setClock } = setupClockDir();
    setClock(WALL_ANCHOR);
    const env = await startCronTest({
      toml: `[cron]\nmanualTick = true\nnoJitter = true\nclock = "file:${clockFile}"\n`,
    });
    const firstFire = minuteAfter(WALL_ANCHOR);
    const task = await env.cron().addTask({ cron: '* * * * *', prompt: 'persisted', recurring: true });
    setClock(firstFire);
    const doneFirst = waitTurnDone(env.main());
    queue = [{ text: 'first fire' }];
    await env.cron().tick();
    await doneFirst;
    await env.stores.flush();
    expect(env.cron().getTask(task.id)?.lastFiredAt).toBe(firstFire);
    await env.cron().addTask({ cron: '0 12 * * *', prompt: 'noon', recurring: true });

    await env.remount();
    const restored = env.cron();
    expect(restored.list().map((entry) => [entry.prompt, entry.lastFiredAt])).toEqual([
      ['persisted', firstFire],
      ['noon', undefined],
    ]);

    setClock(firstFire + 60_000);
    const doneSecond = waitTurnDone(env.main());
    queue = [{ text: 'second fire' }];
    await restored.tick();
    await doneSecond;
    await env.stores.flush();

    const fires = cronFireEntries(env.stores);
    expect(fires).toHaveLength(2);
    const origin = fires[1]!.meta?.origin as unknown as CronJobOrigin;
    expect(origin).toMatchObject({ jobId: task.id, coalescedCount: 1, stale: false });
    await env.dispose();
  });

  it('restricts cron tools to the main agent', async () => {
    const env = await startCronTest({ toml: MANUAL_TICK_TOML });
    const sub = await env.session.create({ agentId: 'sub-1', systemPrompt: 'sub-host' });
    await sub.ready();

    queue = [
      { toolCall: { name: 'CronCreate', arguments: JSON.stringify({ cron: '*/5 * * * *', prompt: 'ping' }) } },
      { text: 'done' },
    ];
    await env.runTurn('go', sub);
    expect(toolResultTexts(env.stores, 'sub-1').at(-1)).toBe(
      'Cron tools are only supported by the main agent.',
    );

    queue = [{ toolCall: { name: 'CronList', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn('go', sub);
    expect(toolResultTexts(env.stores, 'sub-1').at(-1)).toBe(
      'Cron tools are only supported by the main agent.',
    );

    queue = [
      { toolCall: { name: 'CronDelete', arguments: JSON.stringify({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }) } },
      { text: 'done' },
    ];
    await env.runTurn('go', sub);
    expect(toolResultTexts(env.stores, 'sub-1').at(-1)).toBe(
      'Cron tools are only supported by the main agent.',
    );
    expect(toolResultIsErrors(env.stores, 'sub-1')).toEqual([true, true, true]);

    expect(env.cron().list()).toEqual([]);
    await env.dispose();
  });
});
