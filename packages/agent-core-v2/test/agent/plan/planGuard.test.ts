/**
 * Scenario: plan-mode Harness constraints as the `'plan-guard'` executor hook.
 * Responsibilities: verify Write/Edit plan-file short-circuit and denies,
 * TaskStop/Cron denies, fall-through delegation, and every ExitPlanMode review
 * branch (approve with/without option, Reject and Exit, Revise, dismiss,
 * auto / no-plan / empty-plan / non-plan_review skips) with telemetry.
 * Wiring: real wire and plan services; the executor slot carries a
 * `'permission'` stand-in so hook ordering and next() delegation are
 * observable; `IAgentToolApprovalService` is a recording stub.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/agent/plan/planGuard.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  ApprovalResponse,
  PermissionMode,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { IAgentPlanService } from '#/agent/plan/plan';
import { AgentPlanService } from '#/agent/plan/planService';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  AuthorizeToolExecutionResult,
  ToolBeforeExecuteContext,
  ToolDidExecuteContext,
} from '#/agent/toolExecutor/toolHooks';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { OrderedHookSlot } from '#/hooks';
import type { ToolCall } from '#/kosong/contract/message';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ToolAccesses } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { createFakeHostFs } from '../../tools/fixtures/fake-exec';
import { registerTestAgentWireServices } from '../../wire/stubs';
import { stubPermissionModeService } from '../permissionMode/stubs';

const signal = new AbortController().signal;
const SESSION_DIR = '/session';
const PLAN_ID = 'plan-1';
const PLAN_PATH = `${SESSION_DIR}/agents/test-agent/plans/${PLAN_ID}.md`;

const options = [
  { label: 'Approach A', description: 'Small change.' },
  { label: 'Approach B', description: 'Larger change.' },
] as const;

type AskResult = Extract<PermissionPolicyResult, { kind: 'ask' }>;

interface ApprovalRequestRecord {
  readonly ask: AskResult;
  readonly origin: string;
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id: `call_${name.toLowerCase()}`,
    name,
    arguments: JSON.stringify(args),
  };
}

function hookContext(
  toolName: string,
  input: {
    readonly args?: Record<string, unknown>;
    readonly accesses?: ToolAccesses;
    readonly display?: ToolInputDisplay;
  } = {},
): ToolBeforeExecuteContext {
  const args = input.args ?? {};
  const call = toolCall(toolName, args);
  return {
    turnId: 0,
    signal,
    toolCall: call,
    toolCalls: [call],
    args,
    execution: {
      accesses: input.accesses,
      display: input.display,
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  };
}

function planReviewDisplay(
  input: {
    readonly plan?: string;
    readonly path?: string | undefined;
    readonly options?: readonly (typeof options)[number][] | undefined;
  } = {},
): ToolInputDisplay {
  const display: ToolInputDisplay = {
    kind: 'plan_review',
    plan: input.plan ?? '# Plan',
  };
  const path = 'path' in input ? input.path : PLAN_PATH;
  if (path !== undefined) {
    display.path = path;
  }
  if (input.options !== undefined) {
    display.options = input.options;
  }
  return display;
}

function mapResolution(
  resolution: PermissionPolicyResolution | undefined,
): AuthorizeToolExecutionResult | undefined {
  if (resolution === undefined) return undefined;
  if (resolution.kind !== 'result') {
    throw new Error('the review stub only resolves synthetic results');
  }
  const { kind: _kind, ...result } = resolution;
  return result;
}

describe('AgentPlanService plan-guard hook', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let beforeSlot: OrderedHookSlot<ToolBeforeExecuteContext>;
  let permissionRan: boolean;
  let records: TelemetryRecord[];
  let requests: ApprovalRequestRecord[];
  let approvalResponse: ApprovalResponse;
  let formatDenyMessage: Mock<(message: string) => string>;
  let mode: PermissionMode;
  let files: Map<string, string>;

  beforeEach(() => {
    disposables = new DisposableStore();
    records = [];
    requests = [];
    approvalResponse = { decision: 'approved' };
    formatDenyMessage = vi.fn((message: string) => message);
    mode = 'manual';
    files = new Map();
    permissionRan = false;

    beforeSlot = new OrderedHookSlot<ToolBeforeExecuteContext>();
    // The plan-guard hook registers `before: 'permission'`, so the slot needs
    // a stand-in for the permissionGate hook; the flag proves whether the
    // hook short-circuited or delegated via next().
    beforeSlot.register('permission', async (_ctx, next) => {
      permissionRan = true;
      await next();
    });

    const toolApproval: IAgentToolApprovalService = {
      _serviceBrand: undefined,
      resolvePermissionResolution: async () => {
        throw new Error('resolvePermissionResolution is not used by the plan-guard hook');
      },
      requestToolApproval: async (_context, ask, origin) => {
        requests.push({ ask, origin });
        return mapResolution(ask.resolveApproval?.(approvalResponse));
      },
      formatDenyMessage: (message: string) => formatDenyMessage(message),
      formatApprovalRejectionMessage: (toolName, result) =>
        `Tool "${toolName}" was not run (${result.decision}).`,
    };

    ix = createServices(disposables, {
      additionalServices: (reg) => {
        registerTestAgentWireServices(reg);
        reg.defineInstance(
          IHostFileSystem,
          createFakeHostFs({
            mkdir: vi.fn().mockResolvedValue(undefined),
            readText: vi.fn(async (path: string) => files.get(path) ?? ''),
            writeText: vi.fn(async (path: string, content: string) => {
              files.set(path, content);
            }),
          }),
        );
        reg.definePartialInstance(ISessionContext, {
          sessionId: 'session-1',
          sessionDir: SESSION_DIR,
        });
        reg.definePartialInstance(IAgentContextMemoryService, {});
        reg.definePartialInstance(IAgentContextInjectorService, {
          register: () => ({ dispose: () => {} }),
        });
        reg.definePartialInstance(IAgentTelemetryContextService, { set: () => {} });
        reg.definePartialInstance(IAgentToolExecutorService, {
          hooks: {
            onBeforeExecuteTool: beforeSlot,
            onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>(),
          },
        });
        reg.defineInstance(IAgentToolApprovalService, toolApproval);
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.defineInstance(ITelemetryService, recordingTelemetry(records));
        reg.define(IAgentPlanService, AgentPlanService);
      },
    });
  });

  afterEach(() => disposables.dispose());

  function plan(): IAgentPlanService {
    return ix.get(IAgentPlanService);
  }

  async function enterPlan(): Promise<IAgentPlanService> {
    const svc = plan();
    await svc.enter(PLAN_ID);
    return svc;
  }

  async function run(ctx: ToolBeforeExecuteContext): Promise<ToolBeforeExecuteContext> {
    await beforeSlot.run(ctx);
    return ctx;
  }

  describe('guard', () => {
    it.each(['Write', 'Edit'] as const)(
      'lets a %s that only targets the active plan file through without the permission chain',
      async (toolName) => {
        await enterPlan();
        const ctx = await run(
          hookContext(toolName, {
            args: { path: PLAN_PATH },
            accesses: ToolAccesses.writeFile(PLAN_PATH),
          }),
        );

        expect(ctx.decision).toEqual({});
        expect(permissionRan).toBe(false);
      },
    );

    it('lets multiple writes through when every write access targets the active plan file', async () => {
      await enterPlan();
      const ctx = await run(
        hookContext('Edit', {
          args: { path: PLAN_PATH },
          accesses: [
            { kind: 'file', operation: 'write', path: PLAN_PATH },
            { kind: 'file', operation: 'readwrite', path: PLAN_PATH },
          ],
        }),
      );

      expect(ctx.decision).toEqual({});
      expect(permissionRan).toBe(false);
    });

    it.each(['Write', 'Edit'] as const)(
      'blocks a %s to a non-plan file with a formatted deny reason',
      async (toolName) => {
        await enterPlan();
        const otherPath = '/workspace/src/main.ts';
        const ctx = await run(
          hookContext(toolName, {
            args: { path: otherPath },
            accesses: ToolAccesses.writeFile(otherPath),
          }),
        );

        expect(ctx.decision?.block).toBe(true);
        expect(ctx.decision?.reason).toContain('current plan file');
        expect(ctx.decision?.reason).toContain('ExitPlanMode');
        expect(formatDenyMessage).toHaveBeenCalledWith(
          expect.stringContaining(PLAN_PATH),
        );
        expect(permissionRan).toBe(false);
      },
    );

    it('blocks Write and Edit with no file write access while plan mode is active', async () => {
      await enterPlan();

      for (const toolName of ['Write', 'Edit'] as const) {
        const ctx = await run(
          hookContext(toolName, { args: {}, accesses: ToolAccesses.none() }),
        );
        expect(ctx.decision?.block).toBe(true);
      }
      expect(permissionRan).toBe(false);
    });

    it('blocks mixed plan-file and non-plan-file write accesses', async () => {
      await enterPlan();
      const ctx = await run(
        hookContext('Edit', {
          args: { path: PLAN_PATH },
          accesses: [
            { kind: 'file', operation: 'readwrite', path: PLAN_PATH },
            { kind: 'file', operation: 'write', path: '/workspace/src/main.ts' },
          ],
        }),
      );

      expect(ctx.decision?.block).toBe(true);
      expect(ctx.decision?.reason).toContain('current plan file');
      expect(permissionRan).toBe(false);
    });

    it('blocks TaskStop while plan mode is active', async () => {
      await enterPlan();
      const ctx = await run(hookContext('TaskStop', { args: { task_id: 'bash-abc12345' } }));

      expect(ctx.decision?.block).toBe(true);
      expect(ctx.decision?.reason).toContain('TaskStop');
      expect(ctx.decision?.reason).toContain('ExitPlanMode');
      expect(permissionRan).toBe(false);
    });

    it.each(['CronCreate', 'CronDelete'] as const)(
      'blocks %s while plan mode is active',
      async (toolName) => {
        await enterPlan();
        const ctx = await run(hookContext(toolName, { args: {} }));

        expect(ctx.decision?.block).toBe(true);
        expect(ctx.decision?.reason).toContain(toolName);
        expect(ctx.decision?.reason).toContain('plan mode');
        expect(permissionRan).toBe(false);
      },
    );

    it.each(['Read', 'Grep', 'Bash', 'CronList'] as const)(
      'delegates %s to the permission chain while plan mode is active',
      async (toolName) => {
        await enterPlan();
        const ctx = await run(hookContext(toolName, { args: {} }));

        expect(ctx.decision).toBeUndefined();
        expect(permissionRan).toBe(true);
      },
    );

    it('delegates everything once plan mode has exited', async () => {
      plan();
      const ctx = await run(
        hookContext('Write', {
          args: { path: '/workspace/src/main.ts' },
          accesses: ToolAccesses.writeFile('/workspace/src/main.ts'),
        }),
      );

      expect(ctx.decision).toBeUndefined();
      expect(permissionRan).toBe(true);
    });
  });

  describe('exit plan mode review', () => {
    it('asks through toolApproval under the legacy origin and tracks plan_submitted', async () => {
      await enterPlan();
      const ctx = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(requests).toHaveLength(1);
      expect(requests[0]?.origin).toBe('exit-plan-mode-review-ask');
      expect(requests[0]?.ask.kind).toBe('ask');
      expect(requests[0]?.ask.reason).toEqual({ has_options: false });
      expect(records).toContainEqual({
        event: 'plan_submitted',
        properties: { has_options: false },
      });
      expect(ctx.decision?.syntheticResult).toBeDefined();
      expect(permissionRan).toBe(false);
    });

    it('approves with the chosen option prefix and tracks the chosen option', async () => {
      const svc = await enterPlan();
      approvalResponse = { decision: 'approved', selectedLabel: 'Approach B' };
      const ctx = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay({ options }) }),
      );

      expect(ctx.decision?.syntheticResult?.isError).toBe(false);
      expect(ctx.decision?.syntheticResult?.output).toContain(
        'Selected approach: Approach B',
      );
      expect(ctx.decision?.syntheticResult?.output).toContain(
        'Execute ONLY the selected approach',
      );
      expect(ctx.decision?.syntheticResult?.output).toContain('## Approved Plan:\n# Plan');
      expect(records).toContainEqual({
        event: 'plan_submitted',
        properties: { has_options: true },
      });
      expect(records).toContainEqual({
        event: 'plan_resolved',
        properties: { outcome: 'approved', chosen_option: 'Approach B' },
      });
      expect(await svc.status()).toBeNull();
    });

    it('approves without a selected label and saves the plan path into the output', async () => {
      const svc = await enterPlan();
      const ctx = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(ctx.decision?.syntheticResult?.output).toContain(
        `Plan saved to: ${PLAN_PATH}`,
      );
      expect(ctx.decision?.syntheticResult?.output).not.toContain('Selected approach:');
      expect(records).toContainEqual({
        event: 'plan_resolved',
        properties: { outcome: 'approved' },
      });
      expect(await svc.status()).toBeNull();
    });

    it('omits the saved-to line when the display has no path', async () => {
      await enterPlan();
      const ctx = await run(
        hookContext('ExitPlanMode', {
          display: planReviewDisplay({ plan: '# Draft Plan', path: undefined }),
        }),
      );

      expect(ctx.decision?.syntheticResult?.output).toContain('## Approved Plan:\n# Draft Plan');
      expect(ctx.decision?.syntheticResult?.output).not.toContain('Plan saved to:');
    });

    it('exits plan mode with a stopping error result when the user chooses Reject and Exit', async () => {
      const svc = await enterPlan();
      approvalResponse = { decision: 'rejected', selectedLabel: 'Reject and Exit' };
      const ctx = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(ctx.decision?.syntheticResult).toMatchObject({
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode deactivated.',
      });
      expect(records).toContainEqual({
        event: 'plan_resolved',
        properties: { outcome: 'rejected_and_exited' },
      });
      expect(await svc.status()).toBeNull();
    });

    it('keeps plan mode active with the feedback result when the user requests revisions', async () => {
      const svc = await enterPlan();
      approvalResponse = {
        decision: 'rejected',
        selectedLabel: 'Revise',
        feedback: 'Add verification.',
      };
      const ctx = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(ctx.decision?.syntheticResult?.isError).toBe(false);
      expect(ctx.decision?.syntheticResult?.output).toContain('Add verification.');
      expect(records).toContainEqual({
        event: 'plan_resolved',
        properties: { outcome: 'revise', has_feedback: true },
      });
      expect(await svc.status()).not.toBeNull();
    });

    it('keeps plan mode active with a stopping error result when the user rejects the plan', async () => {
      const svc = await enterPlan();
      approvalResponse = { decision: 'rejected' };
      const ctx = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(ctx.decision?.syntheticResult).toMatchObject({
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode remains active.',
      });
      expect(records).toContainEqual({
        event: 'plan_resolved',
        properties: { outcome: 'rejected' },
      });
      expect(await svc.status()).not.toBeNull();
    });

    it('keeps plan mode active with a dismissed result when the approval is cancelled', async () => {
      const svc = await enterPlan();
      approvalResponse = { decision: 'cancelled' };
      const ctx = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(ctx.decision?.syntheticResult).toMatchObject({
        isError: false,
        output: 'Plan approval dismissed. Plan mode remains active.',
      });
      expect(records).toContainEqual({
        event: 'plan_resolved',
        properties: { outcome: 'dismissed' },
      });
      expect(await svc.status()).not.toBeNull();
    });

    it('skips the review in auto mode', async () => {
      mode = 'auto';
      await enterPlan();
      const ctx = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(requests).toHaveLength(0);
      expect(records).toEqual([]);
      expect(ctx.decision).toBeUndefined();
      expect(permissionRan).toBe(true);
    });

    it('skips the review when no plan is active', async () => {
      plan();
      const ctx = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay() }),
      );

      expect(requests).toHaveLength(0);
      expect(ctx.decision).toBeUndefined();
      expect(permissionRan).toBe(true);
    });

    it('skips the review when the plan is empty', async () => {
      await enterPlan();
      const ctx = await run(
        hookContext('ExitPlanMode', { display: planReviewDisplay({ plan: '   ' }) }),
      );

      expect(requests).toHaveLength(0);
      expect(ctx.decision).toBeUndefined();
      expect(permissionRan).toBe(true);
    });

    it('skips the review for a non-plan_review display', async () => {
      await enterPlan();
      const ctx = await run(
        hookContext('ExitPlanMode', {
          display: { kind: 'generic', summary: 'Presenting plan', detail: {} },
        }),
      );

      expect(requests).toHaveLength(0);
      expect(ctx.decision).toBeUndefined();
      expect(permissionRan).toBe(true);
    });

    it('skips the review when the display is missing', async () => {
      await enterPlan();
      const ctx = await run(hookContext('ExitPlanMode'));

      expect(requests).toHaveLength(0);
      expect(ctx.decision).toBeUndefined();
      expect(permissionRan).toBe(true);
    });
  });
});
