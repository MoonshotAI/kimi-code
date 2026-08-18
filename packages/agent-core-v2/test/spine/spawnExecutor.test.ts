import { describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
  type AgentLLMRequestOverrides,
} from '#/agent/llmRequester/llmRequester';
import type { SpineSpawnTaskInput } from '#/agent/spine/spine';
import {
  executeSpawnBranches,
  maxSpawnBranchCount,
  taskEnvelope,
  type SpawnBranchResult,
} from '#/agent/spine/spineSpawn';
import { APIProviderRateLimitError, APIStatusError } from '#/kosong/contract/errors';
import type { ToolCall } from '#/kosong/contract/message';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type {
  AgentRunHandle,
  AgentRunRequest,
  ISessionSubagentService,
  RunAgentOptions,
} from '#/session/subagent/subagent';

interface FakeAgent {
  readonly id: string;
  removed: boolean;
  cancelled: boolean;
  completionValue: Promise<{ summary: string }>;
}

function fakeRunHandle(turnId: number, completion: Promise<{ summary: string }>): AgentRunHandle {
  const controller = new AbortController();
  return {
    agentId: `agent-${String(turnId)}`,
    turn: {
      id: turnId,
      signal: controller.signal,
      cancel: (reason?: unknown) => {
        controller.abort(reason);
        return true;
      },
      ready: Promise.resolve(),
      result: Promise.resolve({ type: 'completed', steps: 0 } as never),
    },
    completion,
  };
}

interface SalvageStub {
  request?: ReturnType<typeof vi.fn>;
  result?: Promise<AgentLLMRequestFinish>;
}

function buildFakes(tasks: readonly SpineSpawnTaskInput[]): {
  readonly lifecycle: IAgentLifecycleService;
  readonly subagentService: ISessionSubagentService;
  readonly agents: FakeAgent[];
  readonly runCompletionControllers: ReturnType<typeof buildCompletionController>[];
  readonly salvageStubs: SalvageStub[];
} {
  const agents: FakeAgent[] = [];
  const runCompletionControllers = tasks.map(() => buildCompletionController());
  const salvageStubs: SalvageStub[] = tasks.map(() => ({}));

  const lifecycle: IAgentLifecycleService = {
    _serviceBrand: undefined,
    onDidCreate: { event: () => ({ dispose: () => undefined }) } as never,
    onDidDispose: { event: () => ({ dispose: () => undefined }) } as never,
    create: () => Promise.reject(new Error('not used')),
    fork: async (_sourceAgentId, opts) => {
      const index = agents.length;
      const id = `agent-${String(index)}`;
      const agent: FakeAgent = {
        id,
        removed: false,
        cancelled: false,
        completionValue: Promise.resolve({ summary: '' }),
      };
      agents.push(agent);
      const stub = salvageStubs[index]!;
      return {
        id,
        accessor: {
          get: (serviceId: unknown) => {
            if (serviceId === IAgentContextMemoryService) {
              return { get: () => [] };
            }
            if (serviceId === IAgentLLMRequesterService) {
              stub.request ??= vi.fn(
                () => stub.result ?? Promise.reject(new Error('unexpected salvage request')),
              );
              return { request: stub.request };
            }
            throw new Error('unexpected accessor call');
          },
        },
        dispose: () => undefined,
      } as unknown as IAgentScopeHandle;
    },
    get: () => undefined,
    list: () => [],
    broadcastPermissionMode: () => undefined,
    remove: async (agentId) => {
      const agent = agents.find((a) => a.id === agentId);
      if (agent !== undefined) agent.removed = true;
    },
  };

  const subagentService: ISessionSubagentService = {
    _serviceBrand: undefined,
    hooks: { onWillStartAgentTask: { register: () => ({ dispose: () => undefined }) } },
    onDidStopAgentTask: { event: () => ({ dispose: () => undefined }) },
    run: async (agentId: string, _request: AgentRunRequest, opts: RunAgentOptions) => {
      const index = agents.findIndex((a) => a.id === agentId);
      const agent = agents[index];
      if (agent === undefined) throw new Error(`unknown agent ${agentId}`);
      const controller = runCompletionControllers[index];
      if (controller === undefined) throw new Error(`no completion controller for ${agentId}`);

      const onAbort = () => {
        agent.cancelled = true;
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });

      agent.completionValue = controller.promise;
      const completion = agent.completionValue.finally(() => {
        opts.signal.removeEventListener('abort', onAbort);
      });
      return fakeRunHandle(index, completion);
    },
    notifyAgentTaskStopped: () => undefined,
  } as unknown as ISessionSubagentService;

  return { lifecycle, subagentService, agents, runCompletionControllers, salvageStubs };
}

function buildCompletionController() {
  let resolve!: (value: { summary: string }) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<{ summary: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

const TASKS: SpineSpawnTaskInput[] = [
  { summary: 'branch A', prompt: 'do A' },
  { summary: 'branch B', prompt: 'do B' },
];

describe('executeSpawnBranches', () => {
  it('forks with trimTrailingToolCallBatch enabled and the spine-branch label', async () => {
    const { lifecycle, subagentService, runCompletionControllers } = buildFakes(TASKS);
    const forkSpy = vi.spyOn(lifecycle, 'fork');
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.resolve({ summary: 'memory A' });
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    await promise;
    expect(forkSpy).toHaveBeenCalledTimes(2);
    expect(forkSpy).toHaveBeenCalledWith('main', {
      trimTrailingToolCallBatch: true,
      labels: { spineBranch: 'true' },
    });
  });

  it('wraps the task in the spawned-execution-branch envelope with the peer roster', () => {
    const envelope = taskEnvelope(TASKS[0]!, TASKS);
    expect(envelope).toContain('You are a spawned execution branch.');
    expect(envelope).toContain('You are: branch A');
    expect(envelope).toContain('Peer branches in this spawn:\n- branch B');
    expect(envelope).not.toContain('- branch A');
    expect(envelope).toContain(
      'The assignment is already an active branch scope. Begin the assigned work directly. ' +
        'Use spine_open, spine_close, and spine_next only to manage genuine descendant work within this assignment.',
    );
    expect(envelope).toContain(
      'Executable work is defined by the assignment. Inherited context supplies constraints and evidence for that work.',
    );
    expect(envelope).toContain(
      'When the assignment declares a collaboration contract, follow its named root, peer roles, artifact format, update/read protocol, synchronization points, and bounded fallback.',
    );
    expect(envelope).toContain(
      'Before returning your final response, perform the declared final peer read and state which peer deltas you incorporated.',
    );
    expect(envelope).toContain(
      'Treat each <spine_tran_status> update as task-tree parser telemetry for this branch session. ' +
        'Across status updates, executable work remains defined by the assignment.',
    );
    expect(envelope).toContain(
      'Complete this branch by returning exactly one non-empty, tool-free assistant final response containing terminal memory.',
    );
    expect(envelope).toContain('Assignment:\ndo A');
  });

  it('lists every other branch as a peer', () => {
    const envelope = taskEnvelope(TASKS[1]!, TASKS);
    expect(envelope).toContain('You are: branch B');
    expect(envelope).toContain('Peer branches in this spawn:\n- branch A');
    expect(envelope).toContain('When the assignment declares a collaboration contract,');
  });

  it('returns a completed receipt when all branches succeed', async () => {
    const { lifecycle, subagentService, runCompletionControllers } = buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.resolve({ summary: 'memory A' });
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;
    expect(results).toEqual<readonly SpawnBranchResult[]>([
      { summary: 'branch A', outcome: 'completed', memoryBody: 'memory A', executionRef: 'agent-0' },
      { summary: 'branch B', outcome: 'completed', memoryBody: 'memory B', executionRef: 'agent-1' },
    ]);
  });

  it('isolates a single errored branch and keeps the rest', async () => {
    const { lifecycle, subagentService, runCompletionControllers } = buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.reject(new Error('boom'));
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;
    expect(results[0]?.outcome).toBe('errored');
    expect(results[0]?.diagnostic).toContain('boom');
    expect(results[0]?.executionRef).toBe('agent-0');
    expect(results[1]).toEqual({ summary: 'branch B', outcome: 'completed', memoryBody: 'memory B', executionRef: 'agent-1' });
  });

  it('isolates a single aborted branch and keeps the rest', async () => {
    const { lifecycle, subagentService, runCompletionControllers } = buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    const abortError = new Error('user cancelled');
    abortError.name = 'AbortError';
    runCompletionControllers[0]!.reject(abortError);
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;
    expect(results[0]?.outcome).toBe('aborted');
    expect(results[0]?.diagnostic).toContain('user cancelled');
    expect(results[1]).toEqual({ summary: 'branch B', outcome: 'completed', memoryBody: 'memory B', executionRef: 'agent-1' });
  });

  it('treats an empty summary as errored', async () => {
    const { lifecycle, subagentService, runCompletionControllers } = buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.resolve({ summary: '   ' });
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;
    expect(results[0]?.outcome).toBe('errored');
    expect(results[0]?.diagnostic).toBe('child completed without a non-empty final memory');
    expect(results[0]?.memoryBody).toBe('child completed without a non-empty final memory');
    expect(results[1]).toEqual({ summary: 'branch B', outcome: 'completed', memoryBody: 'memory B', executionRef: 'agent-1' });
  });

  it('aborts unfinished branches when the turn signal is aborted and releases all agents', async () => {
    const { lifecycle, subagentService, agents } = buildFakes(TASKS);
    const controller = new AbortController();
    const promise = executeSpawnBranches(
      { lifecycle, subagentService },
      TASKS,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort('turn cancelled');
    const results = await promise;
    expect(results.every((r) => r.outcome === 'aborted')).toBe(true);
    expect(agents.every((a) => a.removed)).toBe(true);
  });

  it('releases all agents in finally even when some fail', async () => {
    const { lifecycle, subagentService, agents, runCompletionControllers } = buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.resolve({ summary: 'memory A' });
    runCompletionControllers[1]!.reject(new Error('boom'));
    await promise;
    expect(agents.every((a) => a.removed)).toBe(true);
  });

  it('errors a branch whose fork fails, aborts live siblings, and still releases them', async () => {
    const { lifecycle, subagentService, agents, runCompletionControllers } = buildFakes(TASKS);
    const originalFork = lifecycle.fork;
    let forkCalls = 0;
    lifecycle.fork = async (sourceAgentId, opts) => {
      forkCalls += 1;
      if (forkCalls === 2) throw new Error('fork denied');
      return originalFork(sourceAgentId, opts);
    };

    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    const abortError = new Error('turn cancelled');
    abortError.name = 'AbortError';
    runCompletionControllers[0]!.reject(abortError);
    const results = await promise;

    expect(results[0]?.outcome).toBe('aborted');
    expect(results[0]?.diagnostic).toContain('a sibling branch failed to start');
    expect(results[1]?.outcome).toBe('errored');
    expect(results[1]?.diagnostic).toContain('fork denied');
    expect(agents).toHaveLength(1);
    expect(agents[0]?.removed).toBe(true);
  });

  it('returns results even when releasing a branch fails', async () => {
    const { lifecycle, subagentService, runCompletionControllers } = buildFakes(TASKS);
    lifecycle.remove = async () => {
      throw new Error('remove failed');
    };
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.resolve({ summary: 'memory A' });
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;
    expect(results.every((r) => r.outcome === 'completed')).toBe(true);
  });

  function salvageFinish(text: string, toolCalls: ToolCall[] = []): AgentLLMRequestFinish {
    return {
      message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls },
    } as unknown as AgentLLMRequestFinish;
  }

  it('salvages terminal memory from a branch that fails with a salvageable provider error', async () => {
    const { lifecycle, subagentService, salvageStubs, runCompletionControllers } =
      buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    salvageStubs[0]!.result = Promise.resolve(
      salvageFinish('confirmed progress: parsed 3 of 5 files'),
    );
    runCompletionControllers[0]!.reject(new APIStatusError(500, 'Internal Server Error'));
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;

    expect(results[0]?.outcome).toBe('errored');
    expect(results[0]?.memoryBody).toBe('confirmed progress: parsed 3 of 5 files');
    expect(results[0]?.diagnostic).toContain('Internal Server Error');
    expect(results[1]?.outcome).toBe('completed');

    const request = salvageStubs[0]!.request!;
    expect(request).toHaveBeenCalledTimes(1);
    const [overrides, onPart, requestSignal] = request.mock.calls[0]! as [
      AgentLLMRequestOverrides,
      unknown,
      AbortSignal,
    ];
    expect(overrides.tools).toEqual([]);
    expect(overrides.retry).toEqual({ maxAttempts: 1 });
    expect(overrides.source).toEqual({ type: 'operation', requestKind: 'spine_spawn_salvage' });
    const salvageText = overrides.messages
      ?.at(-1)
      ?.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    expect(salvageText).toContain('Do not continue execution');
    expect(salvageText).toContain('<failure-diagnostic>');
    expect(salvageText).toContain('Internal Server Error');
    expect(onPart).toBeUndefined();
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(salvageStubs[1]!.request).toBeUndefined();
  });

  it('falls back to the diagnostic when the salvage request itself fails', async () => {
    const { lifecycle, subagentService, salvageStubs, runCompletionControllers } =
      buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    salvageStubs[0]!.result = Promise.reject(new Error('salvage unavailable'));
    runCompletionControllers[0]!.reject(new APIStatusError(500, 'Internal Server Error'));
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;

    expect(results[0]?.outcome).toBe('errored');
    expect(results[0]?.memoryBody).toContain('Internal Server Error');
    expect(results[0]?.diagnostic).toContain('Internal Server Error');
    expect(salvageStubs[0]!.request).toHaveBeenCalledTimes(1);
  });

  it('does not attempt salvage for deterministic failures', async () => {
    const { lifecycle, subagentService, salvageStubs, runCompletionControllers } =
      buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.reject(new APIProviderRateLimitError('Too Many Requests'));
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;

    expect(results[0]?.outcome).toBe('errored');
    expect(results[0]?.memoryBody).toContain('Too Many Requests');
    expect(salvageStubs[0]!.request).toBeUndefined();
  });

  it('discards a salvage response that contains tool calls', async () => {
    const { lifecycle, subagentService, salvageStubs, runCompletionControllers } =
      buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    salvageStubs[0]!.result = Promise.resolve(
      salvageFinish('should not be used', [
        { type: 'function', id: 'call-1', name: 'Bash', arguments: '{}' },
      ]),
    );
    runCompletionControllers[0]!.reject(new APIStatusError(500, 'Internal Server Error'));
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;

    expect(results[0]?.outcome).toBe('errored');
    expect(results[0]?.memoryBody).toContain('Internal Server Error');
  });

  it('discards an empty salvage response', async () => {
    const { lifecycle, subagentService, salvageStubs, runCompletionControllers } =
      buildFakes(TASKS);
    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    salvageStubs[0]!.result = Promise.resolve(salvageFinish('   '));
    runCompletionControllers[0]!.reject(new APIStatusError(500, 'Internal Server Error'));
    runCompletionControllers[1]!.resolve({ summary: 'memory B' });
    const results = await promise;

    expect(results[0]?.outcome).toBe('errored');
    expect(results[0]?.memoryBody).toContain('Internal Server Error');
  });

  it('skips salvage when the batch is already aborted by a start failure', async () => {
    const { lifecycle, subagentService, salvageStubs, runCompletionControllers } =
      buildFakes(TASKS);
    const originalFork = lifecycle.fork;
    let forkCalls = 0;
    lifecycle.fork = async (sourceAgentId, opts) => {
      forkCalls += 1;
      if (forkCalls === 2) throw new Error('fork denied');
      return originalFork(sourceAgentId, opts);
    };

    const promise = executeSpawnBranches({ lifecycle, subagentService }, TASKS, makeSignal());
    runCompletionControllers[0]!.reject(new APIStatusError(500, 'Internal Server Error'));
    const results = await promise;

    expect(results[0]?.outcome).toBe('aborted');
    expect(results[1]?.outcome).toBe('errored');
    expect(salvageStubs[0]!.request).toBeUndefined();
  });
});

describe('maxSpawnBranchCount', () => {
  it('computes branch capacity as maxThreads - 1', () => {
    expect(maxSpawnBranchCount(4)).toBe(3);
    expect(maxSpawnBranchCount(2)).toBe(1);
  });
});
