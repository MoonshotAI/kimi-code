import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { userCancellationReason } from '#/_base/utils/abort';
import { IAgentBackgroundService } from '#/agent/background';
import type { ILogger, LogPayload } from '#/app/log';
import { IAgentProfileService } from '#/agent/profile';
import {
  AgentTool,
  AgentToolInputSchema,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  type AgentToolRunOverride,
} from '#/agent/agentTool';
import { ToolAccesses } from '#/agent/tool';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { executeTool } from '../tools/fixtures/execute-tool';
import {
  agentToolServices,
  createTestAgent,
  type TestAgentContext,
} from '../harness';

const signal = new AbortController().signal;
const PARENT_AGENT_ID = 'main';

interface CapturedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload: LogPayload | undefined;
}

function context<Input>(args: Input, toolCallId = 'call_agent') {
  return { turnId: 0, toolCallId, args, signal };
}

function createLogCapture(): {
  readonly logger: ILogger;
  readonly entries: CapturedLogEntry[];
} {
  const entries: CapturedLogEntry[] = [];
  const logger: ILogger = {
    error: (message, payload) => entries.push({ level: 'error', message, payload }),
    warn: (message, payload) => entries.push({ level: 'warn', message, payload }),
    info: (message, payload) => entries.push({ level: 'info', message, payload }),
    debug: (message, payload) => entries.push({ level: 'debug', message, payload }),
    child: () => logger,
  };
  return { logger, entries };
}

function fakeProfile(isToolActive: (name: string) => boolean = () => true) {
  return { isToolActive: vi.fn(isToolActive) } as unknown as IAgentProfileService;
}

function fakeLifecycle() {
  return {} as never;
}

function fakeKaos() {
  return { cwd: '/repo' } as never;
}

function fakeProcessRunner() {
  return {} as never;
}

function createRunOverride(
  overrides: Partial<AgentToolRunOverride> = {},
): AgentToolRunOverride {
  const run: AgentToolRunOverride = {
    spawn: vi.fn(),
    resume: vi.fn(),
    retry: vi.fn(),
    getProfileName: vi.fn().mockResolvedValue(undefined),
  };
  return Object.assign(run, overrides);
}

describe('AgentTool direct contract', () => {
  let contexts: TestAgentContext[];

  beforeEach(() => {
    contexts = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    const current = contexts;
    contexts = [];
    await Promise.all(current.map((ctx) => ctx.dispose()));
  });

  function makeTool({
    run = createRunOverride(),
    maxRunningTasks,
    isToolActive,
    log,
  }: {
    readonly run?: AgentToolRunOverride;
    readonly maxRunningTasks?: number;
    readonly isToolActive?: (name: string) => boolean;
    readonly log?: ILogger;
  } = {}): {
    readonly ctx: TestAgentContext;
    readonly background: IAgentBackgroundService;
    readonly run: AgentToolRunOverride;
    readonly tool: AgentTool;
  } {
    const ctx =
      maxRunningTasks === undefined
        ? createTestAgent()
        : createTestAgent({
            initialConfig: { background: { maxRunningTasks } },
          });
    contexts.push(ctx);
    const background = ctx.get(IAgentBackgroundService);
    return {
      ctx,
      background,
      run,
      tool: new AgentTool({
        lifecycle: fakeLifecycle(),
        callerAgentId: PARENT_AGENT_ID,
        background,
        profile: fakeProfile(isToolActive),
        cwd: '/repo',
        processRunner: fakeProcessRunner(),
        log,
        runOverride: run,
      }),
    };
  }

  it('accepts the snake_case background parameter', () => {
    const parsed = AgentToolInputSchema.parse({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
      run_in_background: true,
    });

    expect(parsed).toMatchObject({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
      run_in_background: true,
    });
  });

  it('exposes current schema without legacy background, timeout, or model parameters', () => {
    const { tool } = makeTool();
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;

    expect(properties).toHaveProperty('run_in_background');
    expect(properties).toHaveProperty('subagent_type');
    expect(properties).not.toHaveProperty('runInBackground');
    expect(properties).not.toHaveProperty('timeout');
    expect(properties).not.toHaveProperty('model');
  });

  it('describes subagent_type and run_in_background parameters', () => {
    const { tool } = makeTool();
    const properties = (
      tool.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;

    expect(properties['subagent_type']?.description).toContain('coder');
    expect(properties['subagent_type']?.description).toContain('agent type');
    expect(properties['subagent_type']?.description).not.toContain('registry');
    expect(properties['run_in_background']?.description).toContain('false');
  });

  it('explains the fixed background subagent timeout', () => {
    const { tool } = makeTool();

    expect(DEFAULT_SUBAGENT_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(tool.description).toContain('fixed 30-minute timeout');
    expect(tool.description).not.toContain('operator-configured background timeout');
    expect(tool.description).not.toContain('no time limit');
  });

  it('renders the default agent types and their tool sets', () => {
    const { tool } = makeTool();

    expect(tool.description).toContain('Available agent types');
    expect(tool.description).toContain('- explore:');
    expect(tool.description).toContain('- coder:');
    expect(tool.description).toContain('Tools:');
  });

  it('mentions resume preference and result visibility in the description', () => {
    const { tool } = makeTool();

    expect(tool.description.toLowerCase()).toContain('resume');
    expect(tool.description.toLowerCase()).toContain('only visible to you');
    expect(tool.description.toLowerCase()).toContain('when not to');
  });

  it('normalizes the default subagent type into tool args', () => {
    expect(
      AgentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
      }).subagent_type,
    ).toBe('coder');
    expect(
      AgentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
        subagent_type: '',
      }).subagent_type,
    ).toBe('coder');
    expect(
      AgentToolInputSchema.parse({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
      }).subagent_type,
    ).toBeUndefined();
  });

  it('declares no resource accesses so concurrent Agent calls can run in parallel', async () => {
    const { tool } = makeTool();
    const execution = await tool.resolveExecution({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.accesses).toEqual(ToolAccesses.none());
  });

  it('uses the resumed agent profile in the activity description', async () => {
    const run = createRunOverride({
      getProfileName: vi.fn().mockResolvedValue('explore'),
    });
    const { tool } = makeTool({ run });
    const execution = await tool.resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      resume: ' agent-existing ',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching explore agent: Continue work');
    expect(run.getProfileName).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-existing' }),
    );
  });

  it('falls back to coder for an empty subagent type', async () => {
    const run = createRunOverride({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: Promise.resolve({ result: 'child result' }),
      }),
    });
    const { tool } = makeTool({ run });

    await executeTool(
      tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        subagent_type: '',
      }),
    );

    expect(run.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentToolCallId: 'call_agent',
        profileName: 'coder',
      }),
    );
  });

  it('resumes a foreground subagent when resume is provided', async () => {
    const run = createRunOverride({
      spawn: vi.fn(),
      resume: vi.fn().mockResolvedValue({
        agentId: 'agent-existing',
        profileName: 'explore',
        resumed: true,
        completion: Promise.resolve({ result: 'resumed result' }),
      }),
    });
    const { tool } = makeTool({ run });

    const result = await executeTool(
      tool,
      context({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
      }),
    );

    expect(run.spawn).not.toHaveBeenCalled();
    expect(run.resume).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-existing',
        parentToolCallId: 'call_agent',
        prompt: 'Continue',
        description: 'Continue work',
        runInBackground: false,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.output).toContain('agent_id: agent-existing');
    expect(result.output).toContain('actual_subagent_type: explore');
    expect(result.output).toContain('resumed result');
  });

  it('does not consume a background task slot when validation fails before launch', async () => {
    const run = createRunOverride({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: new Promise(() => {}),
      }),
      resume: vi.fn(),
    });
    const { tool } = makeTool({ run, maxRunningTasks: 1 });

    const invalid = await executeTool(
      tool,
      context({
        prompt: 'Continue',
        description: 'Invalid background resume',
        resume: 'agent-existing',
        subagent_type: 'explore',
        run_in_background: true,
      }),
    );
    const valid = await executeTool(
      tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(invalid).toMatchObject({
      isError: true,
      output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
    });
    expect(valid.output).toContain('status: running');
    expect(run.resume).not.toHaveBeenCalled();
    expect(run.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not recommend disabled task tools when a foreground subagent is detached', async () => {
    let resolveCompletion: (value: { result: string }) => void = () => {};
    const completion = new Promise<{ result: string }>((resolve) => {
      resolveCompletion = resolve;
    });
    const run = createRunOverride({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion,
      }),
    });
    const { background, tool } = makeTool({
      run,
      isToolActive: () => false,
    });

    const running = executeTool(
      tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
      }),
    );
    await vi.waitFor(() => {
      expect(background.list(false)).toHaveLength(1);
    });
    const task = background.list(false)[0]!;

    background.detach(task.taskId);
    const result = await running;

    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('next_step: The completion arrives automatically');
    expect(result.output).not.toContain('TaskOutput');
    expect(result.output).not.toContain('TaskStop');

    resolveCompletion({ result: 'finished later' });
    await expect(background.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('guides the AI with a non-blocking query hint and a resume hint on background launch', async () => {
    const run = createRunOverride({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: new Promise(() => {}),
      }),
    });
    const { tool } = makeTool({ run });

    const result = await executeTool(
      tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    expect(result.output).toContain('next_step:');
    expect(result.output).toContain(`TaskOutput(task_id="${taskId!}", block=false)`);
    expect(result.output).toContain('resume_hint:');
    expect(result.output).toContain('Agent(resume="agent-child"');
    expect(result.output).toMatch(/agent_id.*not.*task_id|task_id.*not.*agent_id/i);
    expect(result.output).toMatch(/task\.lost|task\.failed|task\.killed/);
  });

  it('returns an error when background registration hits the task limit', async () => {
    const run = createRunOverride({
      spawn: vi
        .fn()
        .mockResolvedValueOnce({
          agentId: 'agent-existing',
          profileName: 'coder',
          resumed: false,
          completion: new Promise(() => {}),
        })
        .mockResolvedValueOnce({
          agentId: 'agent-child',
          profileName: 'coder',
          resumed: false,
          completion: new Promise(() => {}),
        }),
    });
    const { tool } = makeTool({ run, maxRunningTasks: 1 });

    const existing = await executeTool(
      tool,
      context({
        prompt: 'Keep busy',
        description: 'Existing work',
        run_in_background: true,
      }),
    );
    const rejected = await executeTool(
      tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(existing.output).toContain('status: running');
    expect(rejected).toMatchObject({
      isError: true,
      output: 'Too many background tasks are already running.',
    });
    expect(run.spawn).toHaveBeenCalledTimes(2);
  });

  it('rejects one of two concurrent background subagents when the task limit is reached', async () => {
    const run = createRunOverride({
      spawn: vi
        .fn()
        .mockResolvedValueOnce({
          agentId: 'agent-first',
          profileName: 'coder',
          resumed: false,
          completion: new Promise(() => {}),
        })
        .mockResolvedValueOnce({
          agentId: 'agent-second',
          profileName: 'coder',
          resumed: false,
          completion: Promise.resolve({ result: 'second result' }),
        }),
    });
    const { tool } = makeTool({ run, maxRunningTasks: 1 });

    const first = executeTool(
      tool,
      context({
        prompt: 'Investigate first',
        description: 'Find first',
        run_in_background: true,
      }),
    );
    const second = executeTool(
      tool,
      context({
        prompt: 'Investigate second',
        description: 'Find second',
        run_in_background: true,
      }),
    );

    const results = await Promise.all([first, second]);

    expect(run.spawn).toHaveBeenCalledTimes(2);
    expect(results).toContainEqual(
      expect.objectContaining({ output: expect.stringContaining('status: running') }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        isError: true,
        output: 'Too many background tasks are already running.',
      }),
    );
  });

  it('returns tool errors when spawning fails', async () => {
    const error = new Error('missing subagent');
    const { logger, entries } = createLogCapture();
    const run = createRunOverride({
      spawn: vi.fn().mockRejectedValue(error),
    });
    const { tool } = makeTool({ run, log: logger });

    const result = await executeTool(
      tool,
      context({ prompt: 'Investigate', description: 'Find cause' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: missing subagent',
    });
    expect(entries).toEqual([
      {
        level: 'warn',
        message: 'subagent launch failed',
        payload: expect.objectContaining({
          toolCallId: 'call_agent',
          runInBackground: false,
          operation: 'spawn',
          subagentType: 'coder',
          error,
        }),
      },
    ]);
  });

  it('logs background registration failures', async () => {
    const error = new Error('background unavailable');
    const { logger, entries } = createLogCapture();
    const run = createRunOverride({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-child',
        profileName: 'coder',
        resumed: false,
        completion: new Promise(() => {}),
      }),
    });
    const { background, tool } = makeTool({ run, log: logger });
    vi.spyOn(background, 'registerTask').mockImplementation(() => {
      throw error;
    });

    const result = await executeTool(
      tool,
      context({
        prompt: 'Investigate',
        description: 'Find cause',
        run_in_background: true,
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'background unavailable',
    });
    expect(entries).toEqual([
      {
        level: 'warn',
        message: 'background agent task registration failed',
        payload: expect.objectContaining({
          toolCallId: 'call_agent',
          agentId: 'agent-child',
          subagentType: 'coder',
          error,
        }),
      },
    ]);
  });

  it('reports a deliberate user interruption when a foreground subagent is cancelled by the user', async () => {
    const controller = new AbortController();
    const run = createRunOverride({
      spawn: vi.fn((options) =>
        Promise.resolve({
          agentId: 'agent-child',
          profileName: 'coder',
          resumed: false,
          completion: new Promise<{ result: string }>((_resolve, reject) => {
            const onAbort = (): void => {
              reject(options.signal.reason);
            };
            if (options.signal.aborted) onAbort();
            else options.signal.addEventListener('abort', onAbort, { once: true });
          }),
        }),
      ),
    });
    const { tool } = makeTool({ run });

    const resultPromise = executeTool(tool, {
      turnId: 0,
      toolCallId: 'call_agent',
      args: { prompt: 'Investigate', description: 'Find cause' },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(userCancellationReason());
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status: failed');
    expect(result.output).not.toContain('was stopped by the user');
    expect(result.output).toContain('not a system error');
    expect(result.output).toContain('capacity');
    expect(result.output).toContain('wait for the user');
  });

  it('returns the spawned agent id when a foreground subagent times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = createRunOverride({
      spawn: vi.fn().mockResolvedValue({
        agentId: 'agent-timeout',
        profileName: 'coder',
        resumed: false,
        completion: new Promise<{ result: string }>(() => {}),
      }),
    });
    const { tool } = makeTool({ run });

    const resultPromise = executeTool(
      tool,
      context({
        prompt: 'Investigate long task',
        description: 'Investigate timeout',
      }),
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_SUBAGENT_TIMEOUT_MS + 5_000);
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.output).toContain('agent_id: agent-timeout');
    expect(result.output).toContain('actual_subagent_type: coder');
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('Agent timed out after 30 minutes.');
    expect(result.output).toContain('Agent(resume="agent-timeout", prompt="continue")');
    expect(result.output).toContain('Use agent_id only; do not set subagent_type.');
  });
});

describe('Agent tool service runtime', () => {
  describe('with a default run override', () => {
    let ctx: TestAgentContext;
    let profile: IAgentProfileService;

    beforeEach(() => {
      const run = createRunOverride();
      ctx = createTestAgent(agentToolServices(run));
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Agent'] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('exposes Agent when a run override is available', () => {
      expect(ctx.toolsData()).toContainEqual(
        expect.objectContaining({
          name: 'Agent',
          active: true,
          source: 'builtin',
        }),
      );
    });

    it('lists available subagent types in the Agent tool description', () => {
      const tool = ctx.get(IAgentToolRegistryService).resolve('Agent');
      expect(tool?.description).toContain('Available agent types');
      expect(tool?.description).toContain('explore');
      expect(tool?.description).toContain('coder');
    });
  });

  describe('with a resolving run override', () => {
    let ctx: TestAgentContext;
    let run: AgentToolRunOverride;
    let profile: IAgentProfileService;
    let tools: IAgentToolRegistryService;

    beforeEach(() => {
      run = createRunOverride({
        spawn: vi.fn().mockResolvedValue({
          agentId: 'agent-child',
          profileName: 'coder',
          resumed: false,
          completion: Promise.resolve({ result: 'child summary' }),
        }),
      });
      ctx = createTestAgent(agentToolServices(run));
      profile = ctx.get(IAgentProfileService);
      tools = ctx.get(IAgentToolRegistryService);
      profile.update({ activeToolNames: ['Agent'] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('runs foreground Agent calls through the service runtime background manager', async () => {
      const tool = tools.resolve('Agent');
      expect(tool).toBeDefined();
      await expect(
        executeTool(tool!, {
          turnId: 0,
          toolCallId: 'call_agent',
          args: {
            prompt: 'Investigate deeply',
            description: 'Investigate deeply',
            subagent_type: 'coder',
          },
          signal,
        }),
      ).resolves.toMatchObject({
        output: [
          'agent_id: agent-child',
          'actual_subagent_type: coder',
          'status: completed',
          '',
          '[summary]',
          'child summary',
        ].join('\n'),
      });
      expect(run.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          profileName: 'coder',
          parentToolCallId: 'call_agent',
          prompt: 'Investigate deeply',
          description: 'Investigate deeply',
          runInBackground: false,
        }),
      );
    });

    it('gates Agent background mode on task management tools', async () => {
      const agentOnlyTool = tools.resolve('Agent');
      expect(agentOnlyTool).toBeDefined();
      await expect(
        executeTool(agentOnlyTool!, {
          turnId: 0,
          toolCallId: 'call_agent',
          args: {
            prompt: 'Investigate deeply',
            description: 'Investigate deeply',
            run_in_background: true,
          },
          signal,
        }),
      ).resolves.toMatchObject({
        isError: true,
        output:
          'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.',
      });

      await ctx.rpc.setActiveTools({ names: ['Agent', 'TaskList', 'TaskOutput', 'TaskStop'] });

      const managedTool = tools.resolve('Agent');
      expect(managedTool).toBeDefined();
      const result = await executeTool(managedTool!, {
        turnId: 0,
        toolCallId: 'call_agent',
        args: {
          prompt: 'Investigate deeply',
          description: 'Investigate deeply',
          run_in_background: true,
        },
        signal,
      });

      expect(result).toMatchObject({
        output: expect.stringContaining('status: running'),
      });
      expect(result.output).toContain('agent_id: agent-child');
      expect(result.output).toContain(
        'resume_hint: To continue or recover this same subagent later, call Agent(resume="agent-child", prompt="...").',
      );
      expect(run.spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          profileName: 'coder',
          parentToolCallId: 'call_agent',
          prompt: 'Investigate deeply',
          description: 'Investigate deeply',
          runInBackground: true,
        }),
      );
    });
  });

  describe('with a non-resuming run override', () => {
    let ctx: TestAgentContext;
    let run: AgentToolRunOverride;
    let profile: IAgentProfileService;
    let tools: IAgentToolRegistryService;

    beforeEach(() => {
      run = createRunOverride();
      ctx = createTestAgent(agentToolServices(run));
      profile = ctx.get(IAgentProfileService);
      tools = ctx.get(IAgentToolRegistryService);
      profile.update({ activeToolNames: ['Agent'] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('rejects Agent resume calls that also specify a subagent type', async () => {
      const tool = tools.resolve('Agent');
      expect(tool).toBeDefined();
      await expect(
        executeTool(tool!, {
          turnId: 0,
          toolCallId: 'call_agent',
          args: {
            prompt: 'Continue',
            description: 'Continue work',
            resume: 'agent-child',
            subagent_type: 'coder',
          },
          signal,
        }),
      ).resolves.toMatchObject({
        isError: true,
        output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
      });
      expect(run.resume).not.toHaveBeenCalled();
    });
  });
});
