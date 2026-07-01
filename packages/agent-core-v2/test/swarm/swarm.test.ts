import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IContextMemory } from '#/contextMemory';
import { IEventSink } from '../../src/eventSink';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  ISubagentHost,
  type QueuedSubagentRunResult,
  type QueuedSubagentTask,
} from '#/subagentHost';
import { ISystemReminderService } from '#/systemReminder';
import { SystemReminderService } from '#/systemReminder/systemReminderService';
import { ISwarmService } from '#/swarm';
import { SwarmService } from '#/swarm/swarmService';
import {
  AgentSwarmTool,
  AgentSwarmToolInputSchema,
} from '#/swarm/tools/agent-swarm';
import type { ExecutableToolContext } from '#/tool';
import { IToolRegistry, ToolRegistryService } from '#/toolRegistry';
import { ITurnService } from '#/turn';
import { IWireRecord } from '#/wireRecord';

import { stubContextMemory, stubWireRecord } from '../contextMemory/stubs';
import { executeTool } from '../tools/fixtures/execute-tool';
import { stubTurnWithHooks } from '../turn/stubs';

const signal = new AbortController().signal;

function context<Input>(
  args: Input,
  toolCallId = 'call_swarm',
): ExecutableToolContext & { readonly args: Input } {
  return { turnId: '0', toolCallId, args, signal };
}

function mockSubagentHost({
  getSwarmItem = () => undefined,
  runQueued = vi.fn().mockResolvedValue([]),
}: {
  readonly getSwarmItem?: (agentId: string) => string | undefined;
  readonly runQueued?: <T>(
    tasks: readonly QueuedSubagentTask<T>[],
  ) => Promise<Array<QueuedSubagentRunResult<T>>>;
} = {}) {
  return {
    getSwarmItem: vi.fn(getSwarmItem),
    runQueued,
  };
}

function mockSwarmMode() {
  return { enter: vi.fn() };
}

describe('SwarmService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IContextMemory, stubContextMemory());
    ix.stub(IWireRecord, stubWireRecord());
    ix.stub(IEventSink, { emit: () => {}, on: () => toDisposable(() => {}) });
    ix.stub(ITurnService, stubTurnWithHooks());
    ix.set(IToolRegistry, new SyncDescriptor(ToolRegistryService));
    ix.stub(ISubagentHost, {});
    ix.set(ISystemReminderService, new SyncDescriptor(SystemReminderService));
    ix.set(ISwarmService, new SyncDescriptor(SwarmService));
  });
  afterEach(() => disposables.dispose());

  it('enter / exit toggle isActive', async () => {
    const swarm = ix.get(ISwarmService);
    expect(swarm.isActive).toBe(false);
    swarm.enter('manual');
    expect(swarm.isActive).toBe(true);
    swarm.exit();
    expect(swarm.isActive).toBe(false);
  });
});

describe('AgentSwarmTool', () => {
  it('applies one subagent_type across templated subagents', async () => {
    const host = mockSubagentHost({
      runQueued: vi.fn().mockResolvedValue([
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
    const tool = new AgentSwarmTool(host, swarmMode);
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
    expect(Object.keys(tool.parameters['properties'] as Record<string, unknown>).at(-1)).toBe(
      'resume_agent_ids',
    );

    const result = await executeTool(tool, context(input));

    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    expect(host.runQueued).toHaveBeenCalledTimes(1);
    expect(host.runQueued).toHaveBeenCalledWith([
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
    ]);
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
    const tool = new AgentSwarmTool(mockSubagentHost(), mockSwarmMode());
    const execution = tool.resolveExecution({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });

    expect(execution.isError).toBeUndefined();
    expect(execution.approvalRule).toBe('AgentSwarm');
    expect(execution.matchesRule).toBeUndefined();
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
      const host = mockSubagentHost();
      const tool = new AgentSwarmTool(host, mockSwarmMode());

      const result = await executeTool(tool, context(testCase.input));

      expect(result.output).toBe(testCase.output);
      expect(result.isError).toBe(true);
      expect(host.runQueued).not.toHaveBeenCalled();
    }
  });

  it('resumes mapped agents before spawning item subagents', async () => {
    const runQueued = vi.fn(
      async <T>(
        tasks: readonly QueuedSubagentTask<T>[],
      ): Promise<Array<QueuedSubagentRunResult<T>>> =>
        tasks.map((task, index) => ({
          task,
          agentId: task.kind === 'resume' ? task.resumeAgentId : `agent-new-${String(index + 1)}`,
          status: 'completed' as const,
          result: `result ${String(index + 1)}`,
        })),
    );
    const host = mockSubagentHost({
      getSwarmItem: (agentId) =>
        ({ 'agent-old-1': 'src/old-a.ts', 'agent-old-2': 'src/old-b.ts' })[agentId],
      runQueued,
    });
    const tool = new AgentSwarmTool(host, mockSwarmMode());
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

    expect(host.runQueued).toHaveBeenCalledWith([
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
    ]);
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
    const runQueued = vi.fn(
      async <T>(
        tasks: readonly QueuedSubagentTask<T>[],
      ): Promise<Array<QueuedSubagentRunResult<T>>> =>
        tasks.map((task) => ({
          task,
          agentId: task.kind === 'resume' ? task.resumeAgentId : 'agent-new',
          status: 'completed' as const,
          result: 'resumed result',
        })),
    );
    const host = mockSubagentHost({
      getSwarmItem: (agentId) => (agentId === 'agent-old-1' ? 'src/old-a.ts' : undefined),
      runQueued,
    });
    const tool = new AgentSwarmTool(host, mockSwarmMode());
    const input = {
      description: 'Resume review',
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
      },
    };

    const result = await executeTool(tool, context(input));

    expect(host.runQueued).toHaveBeenCalledWith([
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
    ]);
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
    const host = mockSubagentHost({
      runQueued: vi.fn().mockImplementation(async (tasks) => [
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
    const tool = new AgentSwarmTool(host, mockSwarmMode());

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
    const host = mockSubagentHost({
      runQueued: vi.fn().mockImplementation(async (tasks) => [
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
    const tool = new AgentSwarmTool(host, mockSwarmMode());

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
    const host = mockSubagentHost({
      runQueued: vi.fn().mockImplementation(async (tasks) => [
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
    const tool = new AgentSwarmTool(host, mockSwarmMode());

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
