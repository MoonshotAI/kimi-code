import type { ToolCall } from '#human/message';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentPlanService, type PlanData } from '#/features/plan/plan';
import { ExitPlanModeTool } from '#/features/plan/tools/exit-plan-mode/exitPlanModeTool';
import type { ToolResult } from '#/tool/toolContract';
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

function planService({
  status = ACTIVE_PLAN,
  exit,
}: {
  readonly status?: PlanData;
  readonly exit?: IAgentPlanService['exit'];
} = {}): IAgentPlanService {
  return {
    _serviceBrand: undefined,
    enter: vi.fn(async () => {}),
    cancel: vi.fn(),
    clear: vi.fn(async () => {}),
    exit: exit ?? vi.fn(),
    resolveFile: async () => undefined,
    recordRevision: vi.fn(async () => {}),
    status: vi.fn(async () => status),
  };
}

describe('AgentPlanService without an EnterPlanMode tool', () => {
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

      it('does not let the model enter plan mode', async () => {
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

        expect(result[0]?.isError).toBe(true);
        expect(await ctx.get(IAgentPlanService).status()).toBeNull();
        expect(records.some((record) => record.event === 'plan_enter_resolved')).toBe(false);
      });
    });
  }
});

describe('ExitPlanModeTool', () => {
  it('refuses to exit when plan mode is inactive', async () => {
    const result = await executeTool(new ExitPlanModeTool(planService({ status: null })), {
      turnId: 7,
      toolCallId: 'call_exit_plan',
      args: {},
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      isError: true,
      output:
        'ExitPlanMode can only be called while plan mode is active. Only the user can turn plan mode on.',
    });
  });

  it('does not use inline plan fallback when no plan file exists', async () => {
    const status = {
      id: 'test-plan',
      content: '',
      path: undefined,
    } as unknown as NonNullable<PlanData>;

    const result = await executeTool(
      new ExitPlanModeTool(planService({ status })),
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
    const parameters = new ExitPlanModeTool(planService()).parameters as {
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
});
