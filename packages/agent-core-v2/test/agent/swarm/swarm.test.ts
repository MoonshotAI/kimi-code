import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSwarmService, type SessionSwarmRunResult, type SessionSwarmTask } from '#/session/swarm/sessionSwarm';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { AgentSwarmService } from '#/agent/swarm/swarmService';
import { SwarmModel } from '#/agent/swarm/swarmOps';
import { AgentSwarmTool, AgentSwarmToolInputSchema } from '#/agent/swarm/tools/agent-swarm';
import type { ExecutableToolContext } from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentWireRecordService } from '#/agent/wireRecord/wireRecord';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentWireService } from '#/wire/tokens';
import type { PersistedRecord } from '#/wire/wireService';
import { WireService } from '#/wire/wireServiceImpl';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';

import { stubContextMemory, stubWireRecord } from '../contextMemory/stubs';
import { executeTool } from '../../tools/fixtures/execute-tool';
import { stubLoopWithHooks } from '../loop/stubs';

const signal = new AbortController().signal;

function context<Input>(
  args: Input,
  toolCallId = 'call_swarm',
): ExecutableToolContext & { readonly args: Input } {
  return { turnId: 0, toolCallId, args, signal };
}

function mockSwarmHost({
  run = vi.fn().mockResolvedValue([]),
  getSwarmItem = vi.fn().mockResolvedValue(undefined),
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly run?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly getSwarmItem?: (...args: any[]) => any;
} = {}) {
  return {
    swarmService: { _serviceBrand: undefined, getSwarmItem, run, cancel: vi.fn() },
    callerAgentId: 'main',
  };
}

function mockSwarmMode() {
  return { _serviceBrand: undefined, isActive: false, enter: vi.fn(), exit: vi.fn() };
}

describe('AgentSwarmService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(IAgentWireRecordService, stubWireRecord());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(
      IAgentWireService,
      new SyncDescriptor(WireService, [{ logScope: 'wire', logKey: 'swarm-test' }]),
    );
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(IAgentLoopService, stubLoopWithHooks());
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.stub(IAgentLifecycleService, {});
    ix.stub(ISessionSwarmService, {
      getSwarmItem: async () => undefined,
      run: async () => [],
      cancel: () => {},
    });
    ix.stub(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
    ix.set(IAgentSystemReminderService, new SyncDescriptor(AgentSystemReminderService));
    ix.set(IAgentSwarmService, new SyncDescriptor(AgentSwarmService));
  });
  afterEach(() => disposables.dispose());

  it('enter / exit toggle isActive and emit agent.status.updated via wire', () => {
    const swarm = ix.get(IAgentSwarmService);
    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    expect(swarm.isActive).toBe(false);
    swarm.enter('manual');
    expect(swarm.isActive).toBe(true);
    swarm.exit();
    expect(swarm.isActive).toBe(false);

    expect(events).toEqual([
      { type: 'agent.status.updated', swarmMode: true },
      { type: 'agent.status.updated', swarmMode: false },
      { type: 'context.spliced', start: 0, deleteCount: 1, messages: [] },
    ]);
  });

  it('dispatch persists enter/exit records and replay rebuilds the trigger (silent)', async () => {
    const swarm = ix.get(IAgentSwarmService);
    swarm.enter('manual');

    const log = ix.get(IAppendLogStore);
    const records: PersistedRecord[] = [];
    for await (const record of log.read<PersistedRecord>('wire', 'swarm-test')) {
      records.push(record);
    }
    expect(records).toEqual([
      { type: 'swarm_mode.enter', trigger: 'manual', time: expect.any(Number) },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(
      IAgentWireService,
      new SyncDescriptor(WireService, [{ logScope: 'wire', logKey: 'swarm-replay' }]),
    );
    const fresh = ix2.get(IAgentWireService);
    void fresh.replay(...records);
    expect(fresh.getModel(SwarmModel)).toBe('manual');
  });
});

describe('AgentSwarmTool', () => {
  it('applies one subagent_type across templated subagents', async () => {
    const host = mockSwarmHost({
      run: vi.fn().mockResolvedValue([
        {
          task: {
            kind: 'spawn',
            data: {
              kind: 'spawn',
              index: 1,
              item: 'src/a.ts',
              prompt: 'Review src/a.ts',
            },
            profileName: 'explore',
            parentToolCallId: 'call_swarm',
            prompt: 'Review src/a.ts',
            description: 'Review files #1 (explore)',
            runInBackground: false,
          },
          agentId: 'agent-explore-1',
          status: 'completed',
          result: 'explore result a',
        },
        {
          task: {
            kind: 'spawn',
            data: {
              kind: 'spawn',
              index: 2,
              item: 'src/b.ts',
              prompt: 'Review src/b.ts',
            },
            profileName: 'explore',
            parentToolCallId: 'call_swarm',
            prompt: 'Review src/b.ts',
            description: 'Review files #2 (explore)',
            runInBackground: false,
          },
          agentId: 'agent-explore-2',
          status: 'completed',
          result: 'explore result b',
        },
      ]),
    });
    const swarmMode = mockSwarmMode();
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), swarmMode);
    const input = {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
      subagent_type: 'explore',
    };

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 128 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        subagent_type: { type: 'string' },
      },
    });
    expect(
      (
        tool.parameters['properties'] as Record<
          string,
          { readonly description?: string }
        >
      )['subagent_type']?.description,
    ).toBe(
      'Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.',
    );
    expect(Object.keys(tool.parameters['properties'] as Record<string, unknown>).at(-1)).toBe(
      'resume_agent_ids',
    );

    const result = await executeTool(tool, context(input));

    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    expect(host.swarmService.run).toHaveBeenCalledTimes(1);
    expect(host.swarmService.run).toHaveBeenCalledWith(expect.objectContaining({ tasks: [
      {
        kind: 'spawn',
        data: {
          kind: 'spawn',
          index: 1,
          item: 'src/a.ts',
          prompt: 'Review src/a.ts',
        },
        profileName: 'explore',
        parentToolCallId: 'call_swarm',
        prompt: 'Review src/a.ts',
        description: 'Review files #1 (explore)',
        swarmIndex: 1,
        swarmItem: 'src/a.ts',
        runInBackground: false,
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      },
      {
        kind: 'spawn',
        data: {
          kind: 'spawn',
          index: 2,
          item: 'src/b.ts',
          prompt: 'Review src/b.ts',
        },
        profileName: 'explore',
        parentToolCallId: 'call_swarm',
        prompt: 'Review src/b.ts',
        description: 'Review files #2 (explore)',
        swarmIndex: 2,
        swarmItem: 'src/b.ts',
        runInBackground: false,
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      },
    ] }));
    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 2</summary>',
        '<subagent agent_id="agent-explore-1" item="src/a.ts" outcome="completed">explore result a</subagent>',
        '<subagent agent_id="agent-explore-2" item="src/b.ts" outcome="completed">explore result b</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('does not expose permission rule argument matching', () => {
    const host = mockSwarmHost();
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode());
    const execution = tool.resolveExecution({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });

    expect(execution.isError).toBeUndefined();
    if (execution.isError === true) throw new Error('expected a successful execution');
    expect(execution.approvalRule).toBe('AgentSwarm');
    expect(execution.matchesRule).toBeUndefined();
  });

  it('description states the enforced input requirements', () => {
    const host = mockSwarmHost();
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode());
    expect(tool.description).toContain('at least 2');
    expect(tool.description).toContain('{{item}}');
    expect(tool.description.toLowerCase()).toContain('distinct');
  });

  it('rejects invalid launch shapes at execution time', async () => {
    const cases = [
      {
        input: {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
        },
        output: 'AgentSwarm supports at most 128 subagents.',
      },
      {
        input: {
          description: 'Review one file',
          prompt_template: 'Review {{item}}',
          items: ['src/only.ts'],
        },
        output: 'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.',
      },
      {
        input: {
          description: 'Review files',
          items: ['src/a.ts', 'src/b.ts'],
        },
        output: 'prompt_template is required when items are provided.',
      },
      {
        input: {
          description: 'Review files',
          prompt_template: 'Review files',
          items: ['src/a.ts', 'src/b.ts'],
        },
        output: 'prompt_template must include the {{item}} placeholder.',
      },
      {
        input: {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['same', 'same'],
        },
        output:
          'Duplicate subagent prompts from items 1 and 2. AgentSwarm requires distinct subagents.',
      },
    ];

    for (const testCase of cases) {
      const host = mockSwarmHost();
      const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode());

      const result = await executeTool(tool, context(testCase.input));

      expect(result.output).toBe(testCase.output);
      expect(result.isError).toBe(true);
      expect(host.swarmService.run).not.toHaveBeenCalled();
    }
  });

  it('resumes mapped agents before spawning item subagents', async () => {
    const run = vi.fn(
      async <T>({
        tasks,
      }: {
        tasks: readonly SessionSwarmTask<T>[];
      }): Promise<Array<SessionSwarmRunResult<T>>> => {
        return tasks.map((task, index) => ({
          task,
          agentId: task.kind === 'resume' ? task.resumeAgentId : `agent-new-${String(index + 1)}`,
          status: 'completed' as const,
          result: `result ${String(index + 1)}`,
        }));
      },
    );
    const persistedItems: Record<string, string> = {
      'agent-old-1': 'src/old-a.ts',
      'agent-old-2': 'src/old-b.ts',
    };
    const getSwarmItem = vi.fn(
      async ({ agentId }: { readonly agentId: string }) => persistedItems[agentId],
    );
    const host = mockSwarmHost({ run, getSwarmItem });
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode());
    const input = {
      description: 'Finish review',
      subagent_type: 'explore',
      prompt_template: 'Review {{item}}',
      items: ['src/new.ts'],
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
        'agent-old-2': 'Continue previous review B',
      },
    };

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        description: 'Resume one agent',
        resume_agent_ids: { 'agent-old-1': 'Continue previous review A' },
      }).success,
    ).toBe(true);

    const result = await executeTool(tool, context(input));

    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-1',
    });
    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-2',
    });
    expect(host.swarmService.run).toHaveBeenCalledWith(expect.objectContaining({ tasks: [
      {
        kind: 'resume',
        data: {
          kind: 'resume',
          index: 1,
          agentId: 'agent-old-1',
          item: 'src/old-a.ts',
          prompt: 'Continue previous review A',
        },
        profileName: 'subagent',
        parentToolCallId: 'call_swarm',
        prompt: 'Continue previous review A',
        description: 'Finish review #1 (resume)',
        swarmIndex: 1,
        swarmItem: 'src/old-a.ts',
        runInBackground: false,
        resumeAgentId: 'agent-old-1',
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      },
      {
        kind: 'resume',
        data: {
          kind: 'resume',
          index: 2,
          agentId: 'agent-old-2',
          item: 'src/old-b.ts',
          prompt: 'Continue previous review B',
        },
        profileName: 'subagent',
        parentToolCallId: 'call_swarm',
        prompt: 'Continue previous review B',
        description: 'Finish review #2 (resume)',
        swarmIndex: 2,
        swarmItem: 'src/old-b.ts',
        runInBackground: false,
        resumeAgentId: 'agent-old-2',
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      },
      {
        kind: 'spawn',
        data: {
          kind: 'spawn',
          index: 3,
          item: 'src/new.ts',
          prompt: 'Review src/new.ts',
        },
        profileName: 'explore',
        parentToolCallId: 'call_swarm',
        prompt: 'Review src/new.ts',
        description: 'Finish review #3 (explore)',
        swarmIndex: 3,
        swarmItem: 'src/new.ts',
        runInBackground: false,
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      },
    ] }));
    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 3</summary>',
        '<subagent mode="resume" agent_id="agent-old-1" item="src/old-a.ts" outcome="completed">result 1</subagent>',
        '<subagent mode="resume" agent_id="agent-old-2" item="src/old-b.ts" outcome="completed">result 2</subagent>',
        '<subagent agent_id="agent-new-3" item="src/new.ts" outcome="completed">result 3</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('allows a single resumed subagent without item subagents', async () => {
    const run = vi.fn(
      async <T>({
        tasks,
      }: {
        tasks: readonly SessionSwarmTask<T>[];
      }): Promise<Array<SessionSwarmRunResult<T>>> => {
        return tasks.map((task, index) => ({
          task,
          agentId: task.kind === 'resume' ? task.resumeAgentId : `agent-new-${String(index + 1)}`,
          status: 'completed' as const,
          result: 'resumed result',
        }));
      },
    );
    const getSwarmItem = vi.fn(async () => 'src/old-a.ts');
    const host = mockSwarmHost({ run, getSwarmItem });
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode());
    const input = {
      description: 'Resume review',
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
      },
    };

    const result = await executeTool(tool, context(input));

    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-1',
    });
    expect(host.swarmService.run).toHaveBeenCalledWith(expect.objectContaining({ tasks: [
      {
        kind: 'resume',
        data: {
          kind: 'resume',
          index: 1,
          agentId: 'agent-old-1',
          item: 'src/old-a.ts',
          prompt: 'Continue previous review A',
        },
        profileName: 'subagent',
        parentToolCallId: 'call_swarm',
        prompt: 'Continue previous review A',
        description: 'Resume review #1 (resume)',
        swarmIndex: 1,
        swarmItem: 'src/old-a.ts',
        runInBackground: false,
        resumeAgentId: 'agent-old-1',
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      },
    ] }));
    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1</summary>',
        '<subagent mode="resume" agent_id="agent-old-1" item="src/old-a.ts" outcome="completed">resumed result</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
  });

  it('reports failed subagents inside the XML result without failing the tool', async () => {
    const host = mockSwarmHost({
      run: vi.fn().mockImplementation(async ({ tasks }) => [
        {
          task: tasks[0],
          agentId: 'agent-coder-1',
          status: 'completed',
          result: 'imports are stable',
        },
        {
          task: tasks[1],
          agentId: 'agent-coder-2',
          status: 'failed',
          error: 'Agent timed out after 30s.',
        },
      ]),
    });
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode());

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      }),
    );

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1, failed: 1</summary>',
        '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
        '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
        '<subagent agent_id="agent-coder-2" item="src/b.ts" outcome="failed">Agent timed out after 30s.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('omits resume hint when incomplete subagents have no agent ids', async () => {
    const host = mockSwarmHost({
      run: vi.fn().mockImplementation(async ({ tasks }) => [
        {
          task: tasks[0],
          status: 'failed',
          error: 'Agent did not start.',
        },
        {
          task: tasks[1],
          status: 'failed',
          error: 'Agent also did not start.',
        },
      ]),
    });
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode());

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      }),
    );

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>failed: 2</summary>',
        '<subagent item="src/a.ts" outcome="failed">Agent did not start.</subagent>',
        '<subagent item="src/b.ts" outcome="failed">Agent also did not start.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
  });

  it('reports partial aborted subagents inside the XML result', async () => {
    const host = mockSwarmHost({
      run: vi.fn().mockImplementation(async ({ tasks }) => [
        {
          task: tasks[0],
          agentId: 'agent-coder-1',
          status: 'completed',
          result: 'imports are stable',
        },
        {
          task: tasks[1],
          agentId: 'agent-coder-2',
          status: 'aborted',
          state: 'started',
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          task: tasks[2],
          status: 'aborted',
          state: 'not_started',
          error:
            'The user manually interrupted this subagent batch before this subagent was started.',
        },
      ]),
    });
    const tool = new AgentSwarmTool(host.swarmService, makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }), mockSwarmMode());

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      }),
    );

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1, aborted: 2</summary>',
        '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
        '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
        '<subagent agent_id="agent-coder-2" item="src/b.ts" state="started" outcome="aborted">The user manually interrupted this subagent batch before this subagent finished.</subagent>',
        '<subagent item="src/c.ts" state="not_started" outcome="aborted">The user manually interrupted this subagent batch before this subagent was started.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });
});
