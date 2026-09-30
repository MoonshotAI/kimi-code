import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  useAgentTools,
  type AgentHandle,
  type ConfigPersist,
  type FeatureSpec,
  type LlmModel,
  type LlmRequester,
  type Message,
  type SessionStores,
  type ToolCall,
  type ToolDescription,
  type ToolMeta,
} from '@moonshot-ai/agent-core';

import { createProfiles } from '#/features/profiles/index';
import {
  createSpawn,
  FORK_EXPERIMENTAL_UNAVAILABLE,
  FORK_WITH_RESUME_UNAVAILABLE,
  SUBAGENT_UPDATE_KEY,
  type SpawnModelEntry,
} from '#/features/spawn/index';
import {
  AgentRunBatch,
  createAgentSwarmSpecs,
  createSwarm,
  createSwarmGuard,
  DEFAULT_SWARM_TIMEOUT_MS,
  mixedAgentSwarmDeniedMessage,
  multipleAgentSwarmDeniedMessage,
  renderSwarmResults,
  resolveSwarmMaxConcurrency,
  SwarmRef,
  type AgentRunAbandonedEvent,
  type AgentRunAttemptHandle,
  type AgentRunAttemptOptions,
  type AgentRunBatchLauncher,
  type AgentRunSuspendedEvent,
  type AgentSwarmSpec,
  type SwarmRunResult,
  type SwarmTask,
} from '#/features/swarm/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

const fastModel: SpawnModelEntry = {
  name: 'fast',
  description: 'Fast test model',
  model: { provider: 'test', model: 'fast-model', capability: UNKNOWN_CAPABILITY },
};

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type ScriptStep =
  | { text: string }
  | { toolCall: { name: string; arguments: string } }
  | { throw: unknown }
  | { hang: true };

type LlmScript = (call: LlmCall) => ScriptStep;

function createMockRequester(script: LlmScript): { requester: LlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    requester: {
      generate: async (_config, content, { onEvent, signal }) => {
        const call: LlmCall = {
          systemPrompt: content.systemPrompt,
          messages: content.messages,
          tools: content.tools ?? [],
        };
        calls.push(call);
        const out = script(call);
        if ('throw' in out) throw out.throw;
        if ('hang' in out) {
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        if ('toolCall' in out) {
          onEvent?.({
            type: 'llm.streaming.part',
            part: {
              type: 'function',
              id: `call-${calls.length}`,
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
    },
  };
}

const script: LlmScript = (call) => {
  const last = call.messages.at(-1);
  if (last !== undefined && last.role === 'tool') return { text: 'done' };
  const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
  if (text.startsWith('SWARM:')) {
    return { toolCall: { name: 'AgentSwarm', arguments: text.slice('SWARM:'.length) } };
  }
  if (text === 'run') return { toolCall: { name: 'Read', arguments: '{}' } };
  if (text.startsWith('SUB:')) {
    return { text: `echo:${text.slice('SUB:'.length)}` };
  }
  return { text: 'parent done' };
};

function bindTestLlm(requester: LlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model });
      agent.setRequester(requester);
    },
  });
}

function bindTestTools(): FeatureSpec {
  return createFeature('test-tools', {
    agent() {
      useAgentTools({
        name: 'Read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text' as const, text: 'file contents' }] }),
      });
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

const tmpDirs: string[] = [];

async function testStores(): Promise<SessionStores> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return openSessionStores(tree, openBlobs(backend.blobs));
}

async function startApp(opts?: {
  script?: LlmScript;
  models?: readonly SpawnModelEntry[];
  workDir?: string;
  withProfiles?: boolean;
  withSpawn?: boolean;
  withConfig?: boolean;
  toml?: string;
  env?: Record<string, string | undefined>;
}) {
  const stores = await testStores();
  const workDir = opts?.workDir ?? (await mkdtemp(join(tmpdir(), 'swarm-work-')));
  const homeDir = await mkdtemp(join(tmpdir(), 'swarm-home-'));
  tmpDirs.push(workDir, homeDir);
  const { requester, calls } = createMockRequester(opts?.script ?? script);
  const swarm = createSwarm({ models: opts?.models, workDir });
  const features: FeatureSpec[] = [swarm, bindTestTools(), bindTestLlm(requester)];
  if (opts?.withSpawn !== false) features.unshift(createSpawn({ workDir }));
  if (opts?.withProfiles !== false) features.unshift(createProfiles({ workDir, home: homeDir }));
  if (opts?.withConfig === true) {
    features.unshift(createConfig({ persist: fakePersist(opts?.toml).persist, env: opts?.env ?? {} }));
  }
  const app = createHarness({ features });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  const runTurn = async (text: string, agent: AgentHandle = main): Promise<void> => {
    const done = waitTurnDone(agent);
    agent.submit(createUserMessage(text));
    await done;
    await stores.flush();
  };
  const dispose = async (): Promise<void> => {
    await app.disposeAsync();
    await stores.dispose();
  };
  return { app, stores, session, main, swarm, calls, workDir, homeDir, runTurn, dispose };
}

function waitTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

function swarmCall(args: unknown): string {
  return `SWARM:${JSON.stringify(args)}`;
}

function trackSubagentUpdates(agent: AgentHandle): Array<{ toolCallId: string; agentId: string }> {
  const updates: Array<{ toolCallId: string; agentId: string }> = [];
  agent.on('tool.update', (event) => {
    if (event.update.key === SUBAGENT_UPDATE_KEY) {
      updates.push({ toolCallId: event.toolCallId, agentId: event.update.text });
    }
  });
  return updates;
}

function toolResultTexts(stores: SessionStores, agentId = MAIN_AGENT_ID): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(stores: SessionStores, agentId = MAIN_AGENT_ID): boolean[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function swarmReminders(stores: SessionStores, agentId = MAIN_AGENT_ID) {
  return (stores.get(agentId)?.getState().history ?? []).filter(
    (entry) => entry.meta?.source === 'reminder' && entry.meta?.key === 'swarm-mode',
  );
}

afterEach(async () => {
  delete process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'];
  delete process.env['KIMI_CODE_EXPERIMENTAL_FLAG'];
  delete process.env['KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY'];
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('agentSwarmSpecs', () => {
  it('validates launch shapes with verbatim messages and expands specs in order', () => {
    const noItem = () => undefined;
    expect(() => createAgentSwarmSpecs({ items: ['a'] }, noItem)).toThrow(
      'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.',
    );
    expect(() => createAgentSwarmSpecs({}, noItem)).toThrow(
      'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.',
    );
    const many = Array.from({ length: 129 }, (_, index) => `item-${index}`);
    expect(() =>
      createAgentSwarmSpecs({ prompt_template: 'do {{item}}', items: many }, noItem),
    ).toThrow('AgentSwarm supports at most 128 subagents.');
    expect(() => createAgentSwarmSpecs({ items: ['a', 'b'] }, noItem)).toThrow(
      'prompt_template is required when items are provided.',
    );
    expect(() =>
      createAgentSwarmSpecs({ prompt_template: 'no placeholder', items: ['a', 'b'] }, noItem),
    ).toThrow('prompt_template must include the {{item}} placeholder.');
    expect(() =>
      createAgentSwarmSpecs({ prompt_template: 'no placeholder', resume_agent_ids: { a: 'go' } }, noItem),
    ).toThrow('prompt_template must include the {{item}} placeholder.');
    expect(() =>
      createAgentSwarmSpecs({ prompt_template: 'do {{item}}', items: ['x', ' x '] }, noItem),
    ).toThrow(
      'Duplicate subagent prompts from items 1 and 2. AgentSwarm requires distinct subagents.',
    );

    const specs = createAgentSwarmSpecs(
      {
        prompt_template: ' Review {{item}} ',
        items: [' src/a.ts ', 'src/b.ts'],
        resume_agent_ids: { ' agent-1 ': ' continue ' },
      },
      (agentId) => (agentId === 'agent-1' ? 'src/old.ts' : undefined),
    );
    expect(specs).toEqual([
      { kind: 'resume', index: 1, agentId: 'agent-1', item: 'src/old.ts', prompt: 'continue' },
      { kind: 'spawn', index: 2, item: 'src/a.ts', prompt: 'Review src/a.ts' },
      { kind: 'spawn', index: 3, item: 'src/b.ts', prompt: 'Review src/b.ts' },
    ]);

    const resumeOnly = createAgentSwarmSpecs({ resume_agent_ids: { a: 'go' } }, noItem);
    expect(resumeOnly).toEqual([
      { kind: 'resume', index: 1, agentId: 'a', item: undefined, prompt: 'go' },
    ]);
  });
});

describe('renderSwarmResults', () => {
  const spawnSpec = (index: number, item: string): AgentSwarmSpec => ({
    kind: 'spawn',
    index,
    item,
    prompt: `prompt ${index}`,
  });

  it('renders summary, resume hint, per-subagent rows, and xml escaping', () => {
    expect(
      renderSwarmResults([
        { spec: spawnSpec(1, 'src/a.ts'), agentId: 'agent-coder-1', status: 'completed', result: 'imports are stable' },
        { spec: spawnSpec(2, 'src/b.ts'), agentId: 'agent-coder-2', status: 'failed', error: 'Agent timed out after 30s.' },
      ]),
    ).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1, failed: 1</summary>',
        '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
        '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
        '<subagent agent_id="agent-coder-2" item="src/b.ts" outcome="failed">Agent timed out after 30s.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );

    expect(
      renderSwarmResults([
        { spec: spawnSpec(1, 'src/a.ts'), status: 'failed', error: 'Agent did not start.' },
        { spec: spawnSpec(2, 'src/b.ts'), status: 'failed', error: 'Agent also did not start.' },
      ]),
    ).toBe(
      [
        '<agent_swarm_result>',
        '<summary>failed: 2</summary>',
        '<subagent item="src/a.ts" outcome="failed">Agent did not start.</subagent>',
        '<subagent item="src/b.ts" outcome="failed">Agent also did not start.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );

    expect(
      renderSwarmResults([
        { spec: spawnSpec(1, 'src/a.ts'), agentId: 'agent-coder-1', status: 'completed', result: 'ok' },
        { spec: spawnSpec(2, 'src/b.ts'), agentId: 'agent-coder-2', status: 'aborted', state: 'started', error: 'The user manually interrupted this subagent batch before this subagent finished.' },
        { spec: spawnSpec(3, 'src/c.ts'), status: 'aborted', state: 'not_started', error: 'The user manually interrupted this subagent batch before this subagent was started.' },
      ]),
    ).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1, aborted: 2</summary>',
        '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
        '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">ok</subagent>',
        '<subagent agent_id="agent-coder-2" item="src/b.ts" state="started" outcome="aborted">The user manually interrupted this subagent batch before this subagent finished.</subagent>',
        '<subagent item="src/c.ts" state="not_started" outcome="aborted">The user manually interrupted this subagent batch before this subagent was started.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );

    expect(
      renderSwarmResults([
        {
          spec: { kind: 'resume', index: 1, agentId: 'agent-1', item: 'a"b&<c>.ts', prompt: 'go' },
          agentId: 'agent-1',
          status: 'completed',
          result: 'resumed',
          stopReason: 'stop "here" & <now>',
        },
      ]),
    ).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1</summary>',
        '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
        '<subagent mode="resume" agent_id="agent-1" item="a&quot;b&amp;&lt;c&gt;.ts" outcome="completed" stop_reason="stop &quot;here&quot; &amp; &lt;now&gt;">resumed</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
  });
});

type MockOutcome =
  | SwarmRunResult<number>
  | { readonly type: 'rate_limited'; readonly agentId: string };

interface MockAttempt {
  readonly task: SwarmTask<number>;
  readonly retryAgentId?: string;
  ready: boolean;
  readonly markReady: () => void;
  readonly outcome: { readonly resolve: (value: MockOutcome) => void };
}

function swarmTask(data: number): SwarmTask<number> {
  return {
    kind: 'spawn',
    data,
    profileName: 'coder',
    parentToolCallId: 'call_swarm',
    prompt: `Review item-${data}`,
    description: `Review #${data}`,
    plan: { ok: true, profileName: 'coder', model: { kind: 'inherit' }, fork: false },
  };
}

function swarmTasks(count: number): SwarmTask<number>[] {
  return Array.from({ length: count }, (_, index) => swarmTask(index + 1));
}

function createMockBatch() {
  const attempts: MockAttempt[] = [];
  const suspended: AgentRunSuspendedEvent[] = [];
  const abandoned: AgentRunAbandonedEvent[] = [];
  let activeTasks: readonly SwarmTask<number>[] = [];

  const createHandle = (
    options: AgentRunAttemptOptions,
    agentId: string,
    retryAgentId?: string,
  ): AgentRunAttemptHandle => {
    const task = activeTasks.find(
      (candidate) =>
        candidate.prompt === options.prompt &&
        candidate.parentToolCallId === options.parentToolCallId,
    )!;
    let resolveOutcome!: (value: MockOutcome) => void;
    const outcomePromise = new Promise<MockOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const record: MockAttempt = {
      task,
      retryAgentId,
      ready: false,
      markReady: () => {
        record.ready = true;
        options.onReady?.();
      },
      outcome: { resolve: resolveOutcome },
    };
    attempts.push(record);
    const completion = new Promise<{ readonly result: string }>((resolve, reject) => {
      const abort = () => reject(options.signal.reason ?? new Error('Aborted'));
      options.signal.addEventListener('abort', abort, { once: true });
      void outcomePromise.then((result) => {
        options.signal.removeEventListener('abort', abort);
        if ('type' in result && result.type === 'rate_limited') {
          reject(Object.assign(new Error('Rate limited'), { kind: 'rate_limit' }));
          return;
        }
        if (result.status === 'completed') {
          resolve({ result: result.result ?? '' });
          return;
        }
        reject(new Error(result.error ?? result.status));
      });
    });
    return { agentId, profileName: 'coder', completion };
  };

  const launcher: AgentRunBatchLauncher = {
    spawn: async (options) => {
      const task = activeTasks.find(
        (candidate) =>
          candidate.prompt === options.prompt &&
          candidate.parentToolCallId === options.parentToolCallId,
      )!;
      return createHandle(options, `agent-${String(task.data)}`);
    },
    resume: async (agentId, options) => createHandle(options, agentId),
    retry: async (agentId, options) => createHandle(options, agentId, agentId),
    suspended: (event) => {
      suspended.push(event);
    },
    abandoned: (event) => {
      abandoned.push(event);
    },
  };

  const runBatch = (
    tasks: readonly SwarmTask<number>[],
    signal?: AbortSignal,
  ): Promise<Array<SwarmRunResult<number>>> => {
    activeTasks = tasks.map((task) => ({ ...task, signal: task.signal ?? signal }));
    return new AgentRunBatch(launcher, activeTasks).run();
  };

  return { runBatch, attempts, suspended, abandoned };
}

describe('AgentRunBatch', () => {
  it('starts five tasks immediately, then one task every 700ms', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockBatch();
      const running = runBatch(swarmTasks(9));

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(699);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(7);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(8);

      await vi.advanceTimersByTimeAsync(700);
      expect(attempts).toHaveLength(9);

      attempts.forEach((attempt, index) => {
        attempt.outcome.resolve({
          task: attempt.task,
          agentId: `agent-${String(index + 1)}`,
          status: 'completed',
          result: `result ${String(index + 1)}`,
        });
      });
      const results = await running;
      expect(results).toHaveLength(9);
      expect(results.every((result) => result.status === 'completed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requeues rate-limited tasks, emits suspended, and drives retries through the retry launcher', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts, suspended } = createMockBatch();
      const running = runBatch(swarmTasks(8), controller.signal);

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-1' });
      attempts[1]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-2' });
      await vi.advanceTimersByTimeAsync(0);
      expect(suspended).toEqual([
        expect.objectContaining({
          agentId: 'agent-1',
          reason: 'Provider rate limit; subagent requeued for retry.',
        }),
        expect.objectContaining({
          agentId: 'agent-2',
          reason: 'Provider rate limit; subagent requeued for retry.',
        }),
      ]);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(500);
      expect(attempts).toHaveLength(5);

      await vi.advanceTimersByTimeAsync(2500);
      expect(attempts).toHaveLength(6);
      expect(attempts[5]!.task.data).toBe(2);
      expect(attempts[5]!.retryAgentId).toBe('agent-2');

      controller.abort();
      const results = await running;
      expect(results).toHaveLength(8);
      expect(results[0]).toMatchObject({
        task: { data: 1 },
        agentId: 'agent-1',
        status: 'aborted',
        state: 'started',
        error: 'The user manually interrupted this subagent batch before this subagent finished.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the only unfinished task on rate limit instead of suspending forever', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts, suspended, abandoned } = createMockBatch();
      const running = runBatch(swarmTasks(2));

      await vi.advanceTimersByTimeAsync(0);
      attempts.forEach((attempt) => {
        attempt.markReady();
      });

      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });
      await vi.advanceTimersByTimeAsync(0);

      attempts[1]!.outcome.resolve({ type: 'rate_limited', agentId: 'agent-2' });
      const results = await running;
      expect(results).toMatchObject([
        { task: { data: 1 }, agentId: 'agent-1', status: 'completed', result: 'completed 1' },
        {
          task: { data: 2 },
          agentId: 'agent-2',
          status: 'failed',
          state: 'started',
          error: 'Rate limited',
        },
      ]);
      expect(suspended).toHaveLength(0);
      expect(abandoned).toEqual([
        expect.objectContaining({ agentId: 'agent-2', outcome: 'failed', error: 'Rate limited' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns completed, started, and not-started results when the batch is cancelled', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { runBatch, attempts } = createMockBatch();
      const running = runBatch(swarmTasks(6), controller.signal);

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toHaveLength(5);

      attempts[0]!.outcome.resolve({
        task: attempts[0]!.task,
        agentId: 'agent-1',
        status: 'completed',
        result: 'completed 1',
      });
      await vi.advanceTimersByTimeAsync(0);

      controller.abort();
      const results = await running;
      expect(
        results.map((result) => ({
          data: result.task.data,
          agentId: result.agentId,
          status: result.status,
          state: result.state,
          error: result.error,
        })),
      ).toEqual([
        { data: 1, agentId: 'agent-1', status: 'completed', state: undefined, error: undefined },
        {
          data: 2,
          agentId: 'agent-2',
          status: 'aborted',
          state: 'started',
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 3,
          agentId: 'agent-3',
          status: 'aborted',
          state: 'started',
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 4,
          agentId: 'agent-4',
          status: 'aborted',
          state: 'started',
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 5,
          agentId: 'agent-5',
          status: 'aborted',
          state: 'started',
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          data: 6,
          agentId: undefined,
          status: 'aborted',
          state: 'not_started',
          error:
            'The user manually interrupted this subagent batch before this subagent was started.',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails only the task whose timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const { runBatch, attempts } = createMockBatch();
      const running = runBatch([{ ...swarmTask(1), timeout: 10_000 }]);

      await vi.advanceTimersByTimeAsync(0);
      attempts[0]!.markReady();

      await vi.advanceTimersByTimeAsync(9999);
      expect(attempts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(running).resolves.toMatchObject([
        {
          task: { data: 1 },
          agentId: 'agent-1',
          status: 'failed',
          state: 'started',
          error: 'Subagent timed out.',
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves max concurrency from the environment', () => {
    expect(resolveSwarmMaxConcurrency({})).toBeUndefined();
    expect(
      resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '' }),
    ).toBeUndefined();
    expect(
      resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '   ' }),
    ).toBeUndefined();
    for (const raw of ['0', '-1', '2.5', 'abc']) {
      expect(() =>
        resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: raw }),
      ).toThrow(/KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY.*positive integer/);
    }
    expect(resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '3' })).toBe(3);
  });
});

function toolCall(name: string): ToolCall {
  return { type: 'function', id: `call_${name}`, name, arguments: '{}' };
}

function deniedText(decision: unknown): string {
  const denied = decision as {
    readonly type: string;
    readonly result: { readonly content: readonly { readonly type: string; readonly text?: string }[] };
  };
  expect(denied.type).toBe('denied');
  return denied.result.content[0]?.text ?? '';
}

describe('swarm guard', () => {
  it('denies every call of a batch with multiple AgentSwarm calls', () => {
    const guard = createSwarmGuard({ isMain: true });
    const batch = [toolCall('AgentSwarm'), toolCall('AgentSwarm')];
    for (const call of batch) {
      expect(deniedText(guard({ toolCall: call, toolCalls: batch }))).toBe(
        multipleAgentSwarmDeniedMessage(false),
      );
    }
    const mixed = [toolCall('AgentSwarm'), toolCall('AgentSwarm'), toolCall('Bash')];
    const text = deniedText(guard({ toolCall: mixed[0]!, toolCalls: mixed }));
    expect(text).toBe(multipleAgentSwarmDeniedMessage(true));
    expect(text).toContain('one swarm at a time');
    expect(text).toContain('must not be combined with other tools in the same response');
  });

  it('denies every call of a batch mixing one AgentSwarm with other tools', () => {
    const guard = createSwarmGuard({ isMain: true });
    const batch = [toolCall('AgentSwarm'), toolCall('Bash')];
    for (const call of batch) {
      expect(deniedText(guard({ toolCall: call, toolCalls: batch }))).toBe(
        mixedAgentSwarmDeniedMessage(),
      );
    }
  });

  it('abstains on a single AgentSwarm call and on batches without AgentSwarm, and appends worker guidance for non-main agents', () => {
    const guard = createSwarmGuard({ isMain: true });
    const single = [toolCall('AgentSwarm')];
    expect(guard({ toolCall: single[0]!, toolCalls: single })).toBeUndefined();
    const plain = [toolCall('Bash'), toolCall('Read')];
    expect(guard({ toolCall: plain[0]!, toolCalls: plain })).toBeUndefined();

    const workerGuard = createSwarmGuard({ isMain: false });
    const batch = [toolCall('AgentSwarm'), toolCall('Bash')];
    expect(deniedText(workerGuard({ toolCall: batch[0]!, toolCalls: batch }))).toBe(
      `${mixedAgentSwarmDeniedMessage()} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`,
    );
  });
});

describe('swarm mode', () => {
  it('enters and exits idempotently and auto-exits a tool-triggered mode at turn end', async () => {
    const env = await startApp();
    const face = env.main.resolve(SwarmRef);
    expect(face.isActive()).toBe(false);

    await face.enter('manual');
    expect(face.isActive()).toBe(true);
    expect(face.state.value.trigger).toBe('manual');
    await face.enter('tool');
    expect(face.state.value.trigger).toBe('manual');
    await face.exit();
    expect(face.isActive()).toBe(false);
    await face.exit();
    expect(face.isActive()).toBe(false);

    await face.enter('tool');
    expect(face.state.value.trigger).toBe('tool');
    await env.runTurn('go');
    await vi.waitFor(() => {
      expect(face.isActive()).toBe(false);
    });
    await env.dispose();
  });

  it('restores the swarm mode from the journal on remount', async () => {
    const env = await startApp();
    await env.main.resolve(SwarmRef).enter('manual');
    await env.session.close(MAIN_AGENT_ID);
    const main = await env.session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
    const face = main.resolve(SwarmRef);
    expect(face.isActive()).toBe(true);
    expect(face.state.value.trigger).toBe('manual');
    await env.dispose();
  });
});

describe('swarm injection', () => {
  it('injects the enter reminder once while manual mode is active and the exit reminder once after exit', async () => {
    const env = await startApp();
    const face = env.main.resolve(SwarmRef);
    await face.enter('manual');
    await env.runTurn('run');
    await env.runTurn('run');

    let reminders = swarmReminders(env.stores);
    expect(reminders).toHaveLength(1);
    expect(extractText(reminders[0]!.message)).toContain('You are now in "agent swarm" mode.');
    const secondCall = env.calls[1]!;
    expect(
      secondCall.messages.some(
        (message) => message.role === 'user' && extractText(message).includes('agent swarm'),
      ),
    ).toBe(true);

    await face.exit();
    await env.runTurn('run');
    await env.runTurn('run');
    reminders = swarmReminders(env.stores);
    expect(reminders).toHaveLength(2);
    expect(extractText(reminders[1]!.message)).toContain('Swarm Mode has ended.');
    await env.dispose();
  });

  it('renders no reminder for tool-triggered swarms', async () => {
    const env = await startApp();
    await env.main.resolve(SwarmRef).enter('tool');
    await env.runTurn('run');
    await env.runTurn('run');
    expect(swarmReminders(env.stores)).toHaveLength(0);
    await env.dispose();
  });

  it('does not re-inject the enter reminder on remount while it is still live in history', async () => {
    const env = await startApp();
    await env.main.resolve(SwarmRef).enter('manual');
    await env.runTurn('run');
    await env.runTurn('run');
    expect(swarmReminders(env.stores)).toHaveLength(1);

    await env.session.close(MAIN_AGENT_ID);
    const main = await env.session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
    const done = waitTurnDone(main);
    main.submit(createUserMessage('run'));
    await done;
    await env.stores.flush();
    expect(swarmReminders(env.stores)).toHaveLength(1);
    await env.dispose();
  });
});

describe('AgentSwarm tool', () => {
  it('gates schema parameters and renders the description with the models section', async () => {
    const env = await startApp({ models: [fastModel] });
    await env.runTurn('hello');
    const tool = env.calls[0]!.tools.find((candidate) => candidate.name === 'AgentSwarm');
    expect(tool).toBeDefined();
    const properties = tool!.parameters['properties'] as Record<string, unknown>;
    expect(Object.keys(properties)).not.toContain('fork');
    expect(Object.keys(properties)).toContain('model');
    expect(tool!.parameters['additionalProperties']).toBe(false);
    expect(tool!.parameters['required']).toEqual(['description']);
    expect(tool!.description).toContain('The placeholder is exactly `{{item}}`.');
    expect(tool!.description).toContain('Available models (pass via model):');
    expect(tool!.description).toContain('- fast: Fast test model');
    expect(tool!.description).toContain('- primary: your current model and thinking level');
    await env.dispose();

    process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'] = 'true';
    const rich = await startApp();
    await rich.runTurn('hello');
    const richTool = rich.calls[0]!.tools.find((candidate) => candidate.name === 'AgentSwarm');
    const richProperties = richTool!.parameters['properties'] as Record<string, unknown>;
    expect(Object.keys(richProperties)).toContain('fork');
    expect(Object.keys(richProperties)).not.toContain('model');
    expect(richTool!.description).not.toContain('Available models');
    await rich.dispose();
    await env.dispose();
  });

  it('rejects fork while the experimental flag is off or combined with resume_agent_ids', async () => {
    const env = await startApp();
    await env.runTurn(
      swarmCall({ description: 'x', prompt_template: 'do {{item}}', items: ['a', 'b'], fork: true }),
    );
    expect(toolResultTexts(env.stores).at(-1)).toBe(FORK_EXPERIMENTAL_UNAVAILABLE);
    expect(toolResultIsErrors(env.stores).at(-1)).toBe(true);

    process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'] = 'true';
    await env.runTurn(
      swarmCall({ description: 'x', resume_agent_ids: { 'subagent-1': 'go' }, fork: true }),
    );
    expect(toolResultTexts(env.stores).at(-1)).toBe(FORK_WITH_RESUME_UNAVAILABLE);
    expect(toolResultIsErrors(env.stores).at(-1)).toBe(true);
    await env.dispose();
  });

  it('runs a three-item swarm to completion and resumes one subagent with its item backfilled', async () => {
    const env = await startApp();
    const updates = trackSubagentUpdates(env.main);
    const face = env.main.resolve(SwarmRef);

    await env.runTurn(
      swarmCall({
        description: 'Review files',
        prompt_template: 'SUB:review {{item}}',
        items: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      }),
    );

    const xml = toolResultTexts(env.stores)[0]!;
    expect(xml).toContain('<summary>completed: 3</summary>');
    expect(xml).not.toContain('resume_hint');
    expect(updates).toHaveLength(3);
    expect(updates.map((update) => update.toolCallId)).toEqual(['call-1', 'call-1', 'call-1']);
    const agentIds = updates.map((update) => update.agentId);
    for (const agentId of agentIds) {
      expect(env.stores.session.getState().roster.agents[agentId]?.source).toBe(
        `spawn:${MAIN_AGENT_ID}:coder`,
      );
    }
    for (const [index, item] of ['src/a.ts', 'src/b.ts', 'src/c.ts'].entries()) {
      expect(xml).toContain(
        `<subagent agent_id="${agentIds[index]}" item="${item}" outcome="completed">echo:review ${item}</subagent>`,
      );
    }
    await vi.waitFor(() => {
      expect(face.isActive()).toBe(false);
    });
    expect(swarmReminders(env.stores)).toHaveLength(0);

    await env.runTurn(
      swarmCall({
        description: 'Follow up',
        resume_agent_ids: { [agentIds[0]!]: 'SUB:again' },
      }),
    );
    const second = toolResultTexts(env.stores)[1]!;
    expect(second).toContain(
      `<subagent mode="resume" agent_id="${agentIds[0]}" item="src/a.ts" outcome="completed">echo:again</subagent>`,
    );
    expect(updates).toHaveLength(4);
    await env.dispose();
  });

  it('fails a hung subagent with the configured swarm timeout', async () => {
    const hanging: LlmScript = (call) => {
      const last = call.messages.at(-1);
      const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
      if (text.startsWith('SWARM:')) {
        return { toolCall: { name: 'AgentSwarm', arguments: text.slice('SWARM:'.length) } };
      }
      if (text === 'SUB:hang') return { hang: true };
      if (text.startsWith('SUB:')) return { text: `echo:${text.slice('SUB:'.length)}` };
      return { text: 'parent done' };
    };
    const env = await startApp({ script: hanging, withConfig: true, toml: '[swarm]\ntimeout_ms = 75\n' });

    await env.runTurn(
      swarmCall({
        description: 'Timeout swarm',
        prompt_template: 'SUB:{{item}}',
        items: ['ok', 'hang'],
      }),
    );

    const xml = toolResultTexts(env.stores)[0]!;
    expect(xml).toContain('<summary>completed: 1, failed: 1</summary>');
    expect(xml).toContain('outcome="failed">Subagent timed out.</subagent>');
    await env.dispose();
  });

  it('registers the swarm config section with env binding and parse fallback', async () => {
    const env = await startApp({ withConfig: true });
    expect(env.app.resolve(ConfigRef).get('swarm')).toEqual({
      timeoutMs: DEFAULT_SWARM_TIMEOUT_MS,
    });
    await env.dispose();

    const bound = await startApp({
      withConfig: true,
      env: { KIMI_CODE_SWARM_TIMEOUT_MS: '250' },
    });
    expect(bound.app.resolve(ConfigRef).get('swarm')).toEqual({ timeoutMs: 250 });
    await bound.dispose();

    const invalid = await startApp({
      withConfig: true,
      env: { KIMI_CODE_SWARM_TIMEOUT_MS: '0' },
    });
    expect(invalid.app.resolve(ConfigRef).get('swarm')).toEqual({
      timeoutMs: DEFAULT_SWARM_TIMEOUT_MS,
    });
    await invalid.dispose();
  });

  it('does not register the AgentSwarm tool when no catalog is available but keeps the facade', async () => {
    const env = await startApp({ withProfiles: false, withSpawn: false });
    await env.runTurn('hello');
    expect(env.calls[0]!.tools.find((candidate) => candidate.name === 'AgentSwarm')).toBeUndefined();
    const face = env.main.resolve(SwarmRef);
    await face.enter('manual');
    expect(face.isActive()).toBe(true);
    await env.dispose();
  });

  it('drives a retry turn with an empty retry-origin message after a rate-limited turn', async () => {
    let rateLimitThrown = false;
    const retryScript: LlmScript = (call) => {
      const last = call.messages.at(-1);
      const isUser = last !== undefined && last.role === 'user';
      const text = isUser ? extractText(last) : '';
      if (text.startsWith('SWARM:')) {
        return { toolCall: { name: 'AgentSwarm', arguments: text.slice('SWARM:'.length) } };
      }
      if (text === 'SUB:flaky' && !rateLimitThrown) {
        rateLimitThrown = true;
        return { throw: Object.assign(new Error('Rate limited'), { kind: 'rate_limit' }) };
      }
      if (isUser && text === '') return { text: 'recovered after retry' };
      if (text.startsWith('SUB:')) return { text: `echo:${text.slice('SUB:'.length)}` };
      return { text: 'parent done' };
    };
    const env = await startApp({ script: retryScript });
    const updates = trackSubagentUpdates(env.main);

    await env.runTurn(
      swarmCall({
        description: 'Retry swarm',
        prompt_template: 'SUB:{{item}}',
        items: ['ok', 'flaky'],
      }),
    );

    const xml = toolResultTexts(env.stores)[0]!;
    expect(xml).toContain('<summary>completed: 2</summary>');
    expect(xml).toContain('recovered after retry');
    expect(updates).toHaveLength(2);

    const agentId = updates
      .map((update) => update.agentId)
      .find((id) =>
        (env.stores.get(id)?.getState().history ?? []).some(
          (entry) => entry.message.role === 'user' && entry.meta?.origin?.kind === 'retry',
        ),
      );
    expect(agentId).toBeDefined();
    const history = env.stores.get(agentId!)?.getState().history ?? [];
    const retryEntries = history.filter(
      (entry) => entry.message.role === 'user' && entry.meta?.origin?.kind === 'retry',
    );
    expect(retryEntries).toHaveLength(1);
    expect(retryEntries[0]!.message.content).toEqual([]);
    const retryCall = env.calls.find((call) => {
      const last = call.messages.at(-1);
      return last !== undefined && last.role === 'user' && last.content.length === 0;
    });
    expect(retryCall).toBeDefined();
    await env.dispose();
  }, 20_000);
});
