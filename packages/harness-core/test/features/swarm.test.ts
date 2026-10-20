import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import {
  createUserEntry,
  type ToolMeta,
} from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type Message,
  type ToolCall,
  type ToolDescription,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type {
  LoopLlmRequester,
  ToolBatchStartingDecision,
  ToolBatchStartingEvent,
} from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, type Agent, type Session } from '@moonshot-ai/agent-core/session/index';

import {
  createConfig,
  ConfigRef,
  type ConfigPersist,
  type ConfigStore,
} from '#/features/config/index';
import {
  createSpawn,
  createStaticProfileCatalog,
  FORK_EXPERIMENTAL_UNAVAILABLE,
  FORK_WITH_RESUME_UNAVAILABLE,
  normalizeAgentProfile,
  SUBAGENT_UPDATE_KEY,
  type ProfileCatalog,
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
  type AgentRunAbandonedEvent,
  type AgentRunAttemptHandle,
  type AgentRunAttemptOptions,
  type AgentRunBatchLauncher,
  type AgentRunSuspendedEvent,
  type AgentSwarmSpec,
  type SwarmRunResult,
  type SwarmTask,
} from '#/features/swarm/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useAgentTools,
  type Harness,
} from '#/runtime/index';

const fastModel: SpawnModelEntry = {
  name: 'fast',
  description: 'Fast test model',
  model: { provider: 'test', name: 'fast-model' },
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

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function createMockRequester(script: LlmScript): { requester: LoopLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const requester: LoopLlmRequester = {
    with: () => requester,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest, control) => {
      const call: LlmCall = {
        systemPrompt: rest.profile?.systemPrompt,
        messages: rest.content?.messages ?? [],
        tools: rest.profile?.tools ?? [],
      };
      calls.push(call);
      const out = script(call);
      if ('throw' in out) throw out.throw;
      if ('hang' in out) {
        await new Promise<never>((_resolve, reject) => {
          control.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }
      return 'toolCall' in out
        ? textOutcome('', [
            {
              type: 'function',
              id: `call-${String(calls.length)}`,
              name: out.toolCall.name,
              arguments: out.toolCall.arguments,
            },
          ])
        : textOutcome(out.text);
    },
  };
  return { calls, requester };
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

function bindTestTools(): Feature<void> {
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

function testCatalog(): ProfileCatalog {
  return createStaticProfileCatalog([
    normalizeAgentProfile({
      name: 'agent',
      description: 'Default agent',
      tools: ['Agent', 'AgentSwarm', 'Bash', 'Read'],
      subagents: ['coder', 'explore', 'plan'],
      systemPrompt: () => 'default agent prompt',
    }),
    normalizeAgentProfile({
      name: 'coder',
      description: 'General software engineering agent',
      whenToUse: 'Use this agent for non-trivial software engineering work.',
      tools: ['Agent', 'AgentSwarm', 'Bash', 'Read', 'Write'],
      subagents: ['coder', 'explore', 'plan'],
      systemPrompt: () => 'coder system prompt',
    }),
    normalizeAgentProfile({
      name: 'explore',
      description: 'Fast codebase exploration with prompt-enforced read-only behavior.',
      whenToUse: 'Fast agent specialized for exploring codebases.',
      tools: ['Read', 'Glob', 'Grep'],
      systemPrompt: () => 'explore system prompt',
    }),
    normalizeAgentProfile({
      name: 'plan',
      description: 'Read-only implementation planning and architecture design.',
      whenToUse: 'Use this agent when the parent agent needs a step-by-step implementation plan',
      tools: ['Read', 'Glob'],
      systemPrompt: () => 'plan system prompt',
    }),
  ]);
}

function captureConfig(): { feature: Feature<void>; face: () => ConfigStore | undefined } {
  let exposed: Readonly<ShallowRef<ConfigStore | undefined>> | undefined;
  const feature = createFeature('config-probe', {
    app: () => {
      exposed = useInject(ConfigRef);
    },
  });
  return { feature, face: () => exposed?.value };
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

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(
  harness: Harness,
  sessionId: string,
  agentId: string,
  requester: LoopLlmRequester,
): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime =
    session !== undefined
      ? harnessInternals(harness.app).agents.get(session)?.get(agentId)
      : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

interface SwarmTestEnv {
  readonly harness: Harness;
  readonly session: Session;
  readonly main: Agent;
  readonly calls: readonly LlmCall[];
  readonly config: () => ConfigStore | undefined;
  runTurn(text: string): Promise<void>;
  flushAgents(): Promise<void>;
  dispose(): Promise<void>;
}

async function startApp(opts?: {
  script?: LlmScript;
  models?: readonly SpawnModelEntry[];
  withCatalog?: boolean;
  withConfig?: boolean;
  toml?: string;
  env?: Record<string, string | undefined>;
}): Promise<SwarmTestEnv> {
  const workDir = await mkdtemp(join(tmpdir(), 'swarm-work-'));
  tmpDirs.push(workDir);
  const { requester, calls } = createMockRequester(opts?.script ?? script);
  const harness = createHarness({ space: memoryHarnessSpace() });
  const configProbe = captureConfig();
  if (opts?.withConfig === true) {
    await harness.app.features.add(
      createConfig({ persist: fakePersist(opts?.toml).persist, env: opts?.env ?? {} }),
    );
  }
  const catalog = opts?.withCatalog === false ? undefined : testCatalog();
  await harness.app.features.add(createSpawn({ catalog, workDir }));
  await harness.app.features.add(createSwarm({ catalog, models: opts?.models, workDir }));
  await harness.app.features.add(bindTestTools());
  await harness.app.features.add(configProbe.feature);
  const session = await harness.app.create({ sessionId: 'sess' });
  const main = await harness.ensureAgent(session, MAIN_AGENT_ID, { systemPrompt: 'main-host' });
  setRequester(harness, 'sess', MAIN_AGENT_ID, requester);
  return {
    harness,
    session,
    main,
    calls,
    config: configProbe.face,
    runTurn: async (text) => {
      await main.loop.runTurn(user(text));
      await main.flush();
    },
    flushAgents: async () => {
      for (const agent of session.agents.values()) await agent.flush();
    },
    dispose: async () => {
      await harness.close();
    },
  };
}

function trackSubagentUpdates(agent: Agent): Array<{ toolCallId: string; agentId: string }> {
  const updates: Array<{ toolCallId: string; agentId: string }> = [];
  agent.loop.subscribe((event) => {
    if (event.type !== 'tool.delta') return;
    if (event.update.key !== SUBAGENT_UPDATE_KEY) return;
    updates.push({ toolCallId: event.toolCallId, agentId: event.update.text });
  });
  return updates;
}

function historyOf(agent: Agent) {
  return agent.view.getState().messages;
}

function toolResultTexts(agent: Agent): string[] {
  return historyOf(agent)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(agent: Agent): boolean[] {
  return historyOf(agent)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function swarmCall(args: unknown): string {
  return `SWARM:${JSON.stringify(args)}`;
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

function guardEvent(toolCalls: readonly ToolCall[]): ToolBatchStartingEvent {
  return { turnId: 1, step: 1, toolCalls };
}

function deniedText(decision: ToolBatchStartingDecision | undefined): string {
  expect(decision).toBeDefined();
  const blocked = decision!;
  expect(blocked.blocked.reason).toBe('denied');
  const part = blocked.result?.content[0];
  return part !== undefined && part.type === 'text' ? part.text : '';
}

describe('swarm guard', () => {
  it('denies a batch with multiple AgentSwarm calls and shares one result', () => {
    const guard = createSwarmGuard({ isMain: true });
    const batch = [toolCall('AgentSwarm'), toolCall('AgentSwarm')];
    const decision = guard(guardEvent(batch));
    expect(deniedText(decision)).toBe(multipleAgentSwarmDeniedMessage(false));
    const mixed = [toolCall('AgentSwarm'), toolCall('AgentSwarm'), toolCall('Bash')];
    const text = deniedText(guard(guardEvent(mixed)));
    expect(text).toBe(multipleAgentSwarmDeniedMessage(true));
    expect(text).toContain('one swarm at a time');
    expect(text).toContain('must not be combined with other tools in the same response');
  });

  it('denies a batch mixing one AgentSwarm with other tools', () => {
    const guard = createSwarmGuard({ isMain: true });
    const batch = [toolCall('AgentSwarm'), toolCall('Bash')];
    expect(deniedText(guard(guardEvent(batch)))).toBe(mixedAgentSwarmDeniedMessage());
  });

  it('abstains on a single AgentSwarm call and on batches without AgentSwarm, and appends worker guidance for non-main agents', () => {
    const guard = createSwarmGuard({ isMain: true });
    expect(guard(guardEvent([toolCall('AgentSwarm')]))).toBeUndefined();
    expect(guard(guardEvent([toolCall('Bash'), toolCall('Read')]))).toBeUndefined();

    const workerGuard = createSwarmGuard({ isMain: false });
    const batch = [toolCall('AgentSwarm'), toolCall('Bash')];
    expect(deniedText(workerGuard(guardEvent(batch)))).toBe(
      `${mixedAgentSwarmDeniedMessage()} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`,
    );
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
  });

  it('rejects fork while the experimental flag is off or combined with resume_agent_ids', async () => {
    const env = await startApp();
    await env.runTurn(
      swarmCall({ description: 'x', prompt_template: 'do {{item}}', items: ['a', 'b'], fork: true }),
    );
    expect(toolResultTexts(env.main).at(-1)).toBe(FORK_EXPERIMENTAL_UNAVAILABLE);
    expect(toolResultIsErrors(env.main).at(-1)).toBe(true);

    process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'] = 'true';
    await env.runTurn(
      swarmCall({ description: 'x', resume_agent_ids: { 'subagent-1': 'go' }, fork: true }),
    );
    expect(toolResultTexts(env.main).at(-1)).toBe(FORK_WITH_RESUME_UNAVAILABLE);
    expect(toolResultIsErrors(env.main).at(-1)).toBe(true);
    await env.dispose();
  });

  it('runs a three-item swarm to completion and resumes one subagent with its item backfilled', async () => {
    const env = await startApp();
    const updates = trackSubagentUpdates(env.main);

    await env.runTurn(
      swarmCall({
        description: 'Review files',
        prompt_template: 'SUB:review {{item}}',
        items: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      }),
    );

    const xml = toolResultTexts(env.main)[0]!;
    expect(xml).toContain('<summary>completed: 3</summary>');
    expect(xml).not.toContain('resume_hint');
    expect(updates).toHaveLength(3);
    expect(updates.map((update) => update.toolCallId)).toEqual(['call-1', 'call-1', 'call-1']);
    const agentIds = updates.map((update) => update.agentId);
    for (const agentId of agentIds) {
      expect(env.session.roster.getState().agents[agentId]?.source).toBe(
        `spawn:${MAIN_AGENT_ID}:coder`,
      );
    }
    for (const [index, item] of ['src/a.ts', 'src/b.ts', 'src/c.ts'].entries()) {
      expect(xml).toContain(
        `<subagent agent_id="${agentIds[index]}" item="${item}" outcome="completed">echo:review ${item}</subagent>`,
      );
    }

    await env.runTurn(
      swarmCall({
        description: 'Follow up',
        resume_agent_ids: { [agentIds[0]!]: 'SUB:again' },
      }),
    );
    const second = toolResultTexts(env.main)[1]!;
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

    const xml = toolResultTexts(env.main)[0]!;
    expect(xml).toContain('<summary>completed: 1, failed: 1</summary>');
    expect(xml).toContain('outcome="failed">Subagent timed out.</subagent>');
    await env.dispose();
  });

  it('registers the swarm config section with env binding and parse fallback', async () => {
    const env = await startApp({ withConfig: true });
    expect(env.config()?.get('swarm')).toEqual({
      timeoutMs: DEFAULT_SWARM_TIMEOUT_MS,
    });
    await env.dispose();

    const bound = await startApp({
      withConfig: true,
      env: { KIMI_CODE_SWARM_TIMEOUT_MS: '250' },
    });
    expect(bound.config()?.get('swarm')).toEqual({ timeoutMs: 250 });
    await bound.dispose();

    const invalid = await startApp({
      withConfig: true,
      env: { KIMI_CODE_SWARM_TIMEOUT_MS: '0' },
    });
    expect(invalid.config()?.get('swarm')).toEqual({
      timeoutMs: DEFAULT_SWARM_TIMEOUT_MS,
    });
    await invalid.dispose();
  });

  it('does not register the AgentSwarm tool when no catalog is available', async () => {
    const env = await startApp({ withCatalog: false });
    await env.runTurn('hello');
    expect(env.calls[0]!.tools.find((candidate) => candidate.name === 'AgentSwarm')).toBeUndefined();
    await env.dispose();
  });

  it('drives a retry turn with an empty retry-origin message after a rate-limited turn', async () => {
    let rateLimited = false;
    const retryScript: LlmScript = (call) => {
      const last = call.messages.at(-1);
      const isUser = last !== undefined && last.role === 'user';
      const text = isUser ? extractText(last) : '';
      if (text.startsWith('SWARM:')) {
        return { toolCall: { name: 'AgentSwarm', arguments: text.slice('SWARM:'.length) } };
      }
      if (text === 'SUB:flaky' && !rateLimited) {
        rateLimited = true;
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

    const xml = toolResultTexts(env.main)[0]!;
    expect(xml).toContain('<summary>completed: 2</summary>');
    expect(xml).toContain('recovered after retry');
    expect(updates).toHaveLength(2);

    await env.flushAgents();
    const agentId = updates
      .map((update) => update.agentId)
      .find((id) => {
        const agent = env.session.agents.get(id);
        return (
          agent !== undefined &&
          historyOf(agent).some(
            (entry) => entry.message.role === 'user' && entry.meta?.origin?.kind === 'retry',
          )
        );
      });
    expect(agentId).toBeDefined();
    const history = historyOf(env.session.agents.get(agentId!)!);
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
