import type { ToolCall } from '#/kosong/contract/message';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgentPlanService, PlanData } from '#/agent/plan/plan';
import { EnterPlanModeTool } from '#/agent/plan/tools/enter-plan-mode';
import {
  ExitPlanModeTool,
  type ExitPlanModeInput,
} from '#/agent/plan/tools/exit-plan-mode';
import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { ToolResult } from '#/tool/toolContract';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';

import { executeTool } from '../../../tools/fixtures/execute-tool';
import { createFakeHostFs } from '../../../tools/fixtures/fake-exec';
import {
  createTestAgent,
  execEnvServices,
  permissionModeServices,
  telemetryServices,
  type TestAgentContext,
} from '../../../harness/agent';
import {
  recordingTelemetry as captureTelemetry,
  type TelemetryRecord,
} from '../../../app/telemetry/stubs';

const ACTIVE_PLAN: NonNullable<PlanData> = {
  id: 'test-plan',
  content: '# Plan\n\n- Inspect\n- Change\n- Verify',
  path: '/tmp/kimi-plan.md',
};

const options = [
  { label: 'Approach A', description: 'Small change.' },
  { label: 'Approach B', description: 'Larger change.' },
] satisfies NonNullable<ExitPlanModeInput['options']>;


function recordingTelemetry(): {
  readonly telemetry: ITelemetryService;
  readonly track2: ReturnType<typeof vi.fn>;
} {
  const track2 = vi.fn();
  return {
    telemetry: {
      _serviceBrand: undefined,
      track: vi.fn(),
      track2,
      withContext: () => recordingTelemetry().telemetry,
      setContext: () => {},
      addAppender: () => ({ dispose: () => {} }),
      removeAppender: () => {},
      setAppender: () => {},
      setEnabled: () => {},
      flush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    },
    track2,
  };
}

function permissionMode(): IAgentPermissionModeService {
  return {
    _serviceBrand: undefined,
    mode: 'auto',
    setMode: () => {},
    onDidChangeMode: () => ({ dispose: () => {} }),
  };
}

function planService({
  status = ACTIVE_PLAN,
  enter,
  exit,
}: {
  readonly status?: PlanData;
  readonly enter?: IAgentPlanService['enter'];
  readonly exit?: IAgentPlanService['exit'];
} = {}): IAgentPlanService {
  return {
    _serviceBrand: undefined,
    enter: enter ?? vi.fn(async () => {}),
    cancel: vi.fn(),
    clear: vi.fn(async () => {}),
    exit: exit ?? vi.fn(),
    recordRevision: vi.fn(async () => {}),
    status: vi.fn(async () => status),
  };
}

describe('EnterPlanModeTool telemetry', () => {
  it('has name, description, parameters, and a stable execution description', async () => {
    const { telemetry } = recordingTelemetry();
    const tool = new EnterPlanModeTool(planService({ status: null }), telemetry);

    expect(tool.name).toBe('EnterPlanMode');
    expect(tool.description).toContain('EnterPlanMode');
    expect(tool.description).toContain('non-trivial implementation task');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });

    const execution = tool.resolveExecution({});
    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Requesting to enter plan mode');
  });

  it('returns an error when plan mode is already active', async () => {
    const { telemetry } = recordingTelemetry();

    const result = await executeTool(new EnterPlanModeTool(planService(), telemetry), {
      turnId: 0,
      toolCallId: 'call_enter_plan',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'Plan mode is already active. Use ExitPlanMode when the plan is ready.',
    });
  });

  it('uses inline guidance when no plan file path is available', async () => {
    const planMode = planService({
      status: null,
      enter: vi.fn(async () => {}),
    });
    vi.mocked(planMode.status).mockResolvedValue(null);
    const { telemetry } = recordingTelemetry();

    const result = await executeTool(new EnterPlanModeTool(planMode, telemetry), {
      turnId: 0,
      toolCallId: 'call_enter_plan',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Wait for the host to provide a plan file path');
    expect(result.output).toContain('no plan file path is available');
  });

  it('uses plan-file guidance when the host provides a plan file path', async () => {
    let active = false;
    const planMode = planService({
      status: null,
      enter: vi.fn(async () => {
        active = true;
      }),
    });
    vi.mocked(planMode.status).mockImplementation(async () => (active ? ACTIVE_PLAN : null));
    const { telemetry } = recordingTelemetry();

    const result = await executeTool(new EnterPlanModeTool(planMode, telemetry), {
      turnId: 0,
      toolCallId: 'call_enter_plan',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(`Plan file: ${ACTIVE_PLAN.path}`);
    expect(result.output).toContain('Write the plan to the plan file with Write or Edit');
  });

  it('returns an error when entering plan mode fails', async () => {
    const { telemetry } = recordingTelemetry();

    const result = await executeTool(
      new EnterPlanModeTool(
        planService({
          status: null,
          enter: vi.fn(async () => {
            throw new Error('cannot prepare plan directory');
          }),
        }),
        telemetry,
      ),
      {
        turnId: 0,
        toolCallId: 'call_enter_plan',
        args: {},
        signal: new AbortController().signal,
      },
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Failed to enter plan mode: cannot prepare plan directory',
    });
  });

  it('tracks direct entry as auto_approved', async () => {
    let active = false;
    const planMode = planService({
      status: null,
      enter: vi.fn(async () => {
        active = true;
      }),
    });
    vi.mocked(planMode.status).mockImplementation(async () => (active ? ACTIVE_PLAN : null));
    const { telemetry, track2 } = recordingTelemetry();

    const result = await executeTool(new EnterPlanModeTool(planMode, telemetry), {
      turnId: 0,
      toolCallId: 'call_enter_plan',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBeFalsy();
    expect(track2).toHaveBeenCalledWith('plan_enter_resolved', {
      outcome: 'auto_approved',
    });
  });
});

describe('AgentPlanService EnterPlanMode telemetry', () => {
  for (const mode of ['manual', 'auto', 'yolo'] as const) {
    describe(`${mode} mode`, () => {
      let ctx: TestAgentContext;
      let toolExecutor: IAgentToolExecutorService;
      const records: TelemetryRecord[] = [];

      beforeEach(() => {
        records.splice(0);
        ctx = createTestAgent(
          execEnvServices({
            hostFs: createFakeHostFs({
              mkdir: vi.fn().mockResolvedValue(undefined),
              readText: vi.fn().mockResolvedValue(''),
            }),
          }),
          permissionModeServices(mode),
          telemetryServices(captureTelemetry(records)),
        );
        toolExecutor = ctx.get(IAgentToolExecutorService);
      });

      afterEach(async () => {
        try {
          await ctx.expectResumeMatches();
        } finally {
          await ctx.dispose();
        }
      });

      it('enters without approval and tracks auto_approved', async () => {
        const call: ToolCall = {
          type: 'function',
          id: `call_enter_plan_${mode}`,
          name: 'EnterPlanMode',
          arguments: '{}',
        };

        const result: ToolResult[] = [];
        for await (const item of toolExecutor.execute([call], {
          turnId: 1,
          signal: new AbortController().signal,
        })) {
          result.push(item.result);
        }

        expect(result[0]?.isError).toBeFalsy();
        expect(result[0]?.output).toContain('Plan mode is now active');
        expect(
          ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'requestApproval'),
        ).toBe(false);
        expect(records).toContainEqual({
          event: 'plan_enter_resolved',
          properties: { agent_id: 'main', outcome: 'auto_approved' },
        });
      });
    });
  }
});

describe('ExitPlanModeTool telemetry', () => {
  it('has name, description, parameters, and a stable execution description', async () => {
    const { telemetry } = recordingTelemetry();
    const tool = new ExitPlanModeTool(planService(), permissionMode(), telemetry);

    expect(tool.name).toBe('ExitPlanMode');
    expect(tool.description).toContain('ExitPlanMode');
    expect(tool.description).toContain('ready for user approval');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        options: expect.objectContaining({ type: 'array' }),
      },
    });

    const execution = await tool.resolveExecution({});
    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Presenting plan and exiting plan mode');
  });

  it('refuses to exit when plan mode is inactive', async () => {
    const { telemetry } = recordingTelemetry();

    const result = await executeTool(
      new ExitPlanModeTool(planService({ status: null }), permissionMode(), telemetry),
      {
      turnId: 7,
      toolCallId: 'call_exit_plan',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      isError: true,
      output:
        'ExitPlanMode can only be called while plan mode is active. Use EnterPlanMode (or /plan) first.',
    });
  });

  it('does not use inline plan fallback when no plan file exists', async () => {
    const { telemetry } = recordingTelemetry();
    const status = {
      id: 'test-plan',
      content: '',
      path: undefined,
    } as unknown as NonNullable<PlanData>;

    const result = await executeTool(
      new ExitPlanModeTool(planService({ status }), permissionMode(), telemetry),
      {
        turnId: 7,
        toolCallId: 'call_exit_plan',
        args: {},
        signal: new AbortController().signal,
      },
    );

    expect(result).toMatchObject({
      isError: true,
      output:
        'No plan file found. Write the plan to the current plan file first, then call ExitPlanMode.',
    });
  });

  it('exposes options[].description as optional with a default of empty string', () => {
    const { telemetry } = recordingTelemetry();
    const parameters = new ExitPlanModeTool(planService(), permissionMode(), telemetry).parameters as {
      properties: {
        options: {
          items: {
            properties: Record<string, unknown>;
            required?: string[];
          };
        };
      };
    };
    const optionSchema = parameters.properties.options.items;

    expect(optionSchema.properties['description']).toMatchObject({ default: '' });
    expect(optionSchema.required).toContain('label');
    expect(optionSchema.required).not.toContain('description');
  });

  it('tracks submitted without options and auto approval', async () => {
    const exit = vi.fn();
    const { telemetry, track2 } = recordingTelemetry();

    const result = await executeTool(new ExitPlanModeTool(planService({ exit }), permissionMode(), telemetry), {
      turnId: 7,
      toolCallId: 'call_exit_plan',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(track2).toHaveBeenCalledWith('plan_submitted', {
      has_options: false,
    });
    expect(track2).toHaveBeenCalledWith('plan_resolved', {
      outcome: 'auto_approved',
    });
  });

  it('tracks submitted with options only when multiple options are present', async () => {
    const { telemetry, track2 } = recordingTelemetry();

    const result = await executeTool(new ExitPlanModeTool(planService(), permissionMode(), telemetry), {
      turnId: 7,
      toolCallId: 'call_exit_plan_options',
      args: { options },
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(false);
    expect(track2).toHaveBeenCalledWith('plan_submitted', {
      has_options: true,
    });
    expect(track2).toHaveBeenCalledWith('plan_resolved', {
      outcome: 'auto_approved',
    });
  });

  it('does not track auto_approved when exitPlanMode fails', async () => {
    const exit = vi.fn(() => {
      throw new Error('state transition failure');
    });
    const { telemetry, track2 } = recordingTelemetry();

    const result = await executeTool(new ExitPlanModeTool(planService({ exit }), permissionMode(), telemetry), {
      turnId: 7,
      toolCallId: 'call_exit_plan_fail',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Failed to exit plan mode');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(track2).toHaveBeenCalledWith('plan_submitted', {
      has_options: false,
    });
    expect(track2).not.toHaveBeenCalledWith('plan_resolved', {
      outcome: 'auto_approved',
    });
  });
});
