/**
 * EnterPlanModeTool tests against the current Agent-backed tool surface.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type { PermissionMode } from '../../src/agent/permission';
import {
  EnterPlanModeInputSchema,
  EnterPlanModeTool,
} from '../../src/tools/builtin/planning/enter-plan-mode';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function makeAgent(
  input: {
    readonly active?: boolean;
    readonly mode?: PermissionMode;
    readonly planFilePath?: string | null;
    readonly enter?: () => Promise<void>;
    readonly emit?: (event: unknown) => void;
  } = {},
): { agent: Agent; requestApproval: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> } {
  let active = input.active ?? false;
  const requestApproval = vi.fn(async () => {
    return { decision: 'approved' };
  });
  const emit = vi.fn((event: unknown) => {
    input.emit?.(event);
    if ((event as { type?: string }).type === 'plan_mode.enter') active = true;
  });
  const enter =
    input.enter ??
    vi.fn(async () => {
      active = true;
    });
  const agent = {
    planMode: {
      get isActive() {
        return active;
      },
      get planFilePath() {
        return input.planFilePath ?? null;
      },
      enter: async (id = 'mock-plan') => {
        emit({ type: 'plan_mode.enter', id });
        await enter();
      },
    },
    permission: { mode: input.mode ?? 'manual' },
    rpc: { requestApproval },
    telemetry: { track: vi.fn() },
    emit,
  } as unknown as Agent;
  return { agent, requestApproval, emit };
}

describe('EnterPlanModeTool', () => {
  it('has name, description, and parameters from the current schema', () => {
    const { agent } = makeAgent();
    const tool = new EnterPlanModeTool(agent);

    expect(tool.name).toBe('EnterPlanMode');
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toContain('Use it when ANY of these conditions apply');
    expect(tool.description).toContain('New Feature Implementation');
    expect(tool.description).toContain('When NOT to use');
    expect(tool.description).toContain('subagent_type="explore"');
    // The explore-agent suggestion must be qualified on Agent availability: EnterPlanMode
    // registers unconditionally, but Agent only registers when a subagentHost exists.
    expect(tool.description).toContain('`Agent` tool is available');
    expect(EnterPlanModeInputSchema.safeParse({}).success).toBe(true);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {},
    });
    expect((tool.parameters['properties'] as Record<string, unknown>)['reason']).toBeUndefined();
  });

  it('returns an error when plan mode is already active', async () => {
    const { agent } = makeAgent({ active: true });
    const result = await executeTool(new EnterPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'tc_1',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('already active');
  });

  it.each(['manual', 'auto', 'yolo'] satisfies PermissionMode[])(
    'enters in %s mode without an approval request',
    async (mode) => {
      const { agent, requestApproval, emit } = makeAgent({ mode });

      const result = await executeTool(new EnterPlanModeTool(agent), {
        turnId: '0',
        toolCallId: `tc_${mode}`,
        args: {},
        signal,
      });

      expect(result.isError).toBeFalsy();
      expect(result.output).toContain('Plan mode is now active');
      expect(requestApproval).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalledWith({ type: 'plan_mode.enter', id: expect.any(String) });
    },
  );

  it('uses inline guidance when no plan file path is available', async () => {
    const { agent } = makeAgent({ mode: 'yolo', planFilePath: null });

    const result = await executeTool(new EnterPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'tc_inline',
      args: {},
      signal,
    });

    expect(result.output).toContain('host to provide a plan file path');
    expect(result.output).not.toContain('`plan` parameter');
    expect(result.output).not.toContain('Write the plan to the plan file');
  });

  it('uses plan-file guidance when the host provides a plan file path', async () => {
    const { agent } = makeAgent({ mode: 'yolo', planFilePath: '/tmp/kimi/plans/example.md' });

    const result = await executeTool(new EnterPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'tc_file',
      args: {},
      signal,
    });

    expect(result.output).toContain('Plan file: /tmp/kimi/plans/example.md');
    expect(result.output).toContain('Write the plan to the plan file');
  });

  it('returns an error when entering plan mode fails', async () => {
    const { agent } = makeAgent({
      mode: 'yolo',
      enter: vi.fn().mockRejectedValue(new Error('state error')),
    });

    const result = await executeTool(new EnterPlanModeTool(agent), {
      turnId: '0',
      toolCallId: 'tc_error',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('state error');
  });

  it('resolveExecution description returns a stable phrase', () => {
    const { agent } = makeAgent();
    const execution = new EnterPlanModeTool(agent).resolveExecution({});
    expect(execution.isError).toBeFalsy();
    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toContain('plan mode');
  });
});
