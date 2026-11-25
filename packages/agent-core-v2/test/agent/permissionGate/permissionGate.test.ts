import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { AgentPermissionGate } from '#/agent/permissionGate/permissionGateService';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  PermissionPolicyEvaluateOptions,
  PermissionPolicyEvaluation,
} from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionMode, PermissionPolicyResolution } from '#/agent/permissionPolicy/types';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import {
  IAgentPermissionRulesService,
  type PermissionRule,
} from '#/agent/permissionRules/permissionRules';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  createAutoReviewReviewer,
  resolveAutoReview,
} from '#/features/autoReview/autoReviewGate';
import {
  type AutoReviewOutcome,
  type IAutoReviewService,
} from '#/features/autoReview/review';
import type { ToolCall } from '#human/message';

import { stubFlag } from '../../app/flag/stubs';

import { stubPermissionModeService } from '../permissionMode/stubs';
import { stubPermissionRulesService } from '../permissionRules/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../toolExecutor/stubs';

function makeContext(
  toolName: string,
  args: Record<string, unknown> = {},
): ResolvedToolExecutionHookContext {
  const toolCall: ToolCall = {
    type: 'function',
    id: `call-${toolName}`,
    name: toolName,
    arguments: JSON.stringify(args),
  };
  return {
    turnId: 1,
    signal: new AbortController().signal,
    toolCall,
    toolCalls: [toolCall],
    args,
    execution: {
      description: `Approve ${toolName}`,
      approvalRule: toolName,
      execute: () => Promise.resolve({ output: '' }),
    },
  };
}

describe('AgentPermissionGate', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let rules: readonly PermissionRule[];
  let policyResult: PermissionPolicyEvaluation | undefined;
  let manualPolicyResult: PermissionPolicyEvaluation | undefined;
  let autoReviewEnabled: boolean;
  let autoReviewOutcome: AutoReviewOutcome;
  let review: ReturnType<typeof vi.fn<IAutoReviewService['review']>>;
  let records: TelemetryRecord[];
  let executorEvents: ToolExecutorEventStubs;
  let resolvePermissionResolution: ReturnType<
    typeof vi.fn<IAgentToolApprovalService['resolvePermissionResolution']>
  >;
  let requestToolApproval: ReturnType<
    typeof vi.fn<IAgentToolApprovalService['requestToolApproval']>
  >;

  beforeEach(() => {
    disposables = new DisposableStore();
    mode = 'auto';
    rules = [];
    policyResult = undefined;
    manualPolicyResult = undefined;
    autoReviewEnabled = false;
    autoReviewOutcome = { decision: 'allow', risk: 'low' };
    review = vi.fn(async () => autoReviewOutcome);
    records = [];
    executorEvents = stubToolExecutorEvents();
    resolvePermissionResolution = vi.fn(async () => undefined);
    requestToolApproval = vi.fn(async () => undefined);
    const toolApproval: IAgentToolApprovalService = {
      _serviceBrand: undefined,
      resolvePermissionResolution,
      requestToolApproval,
      formatDenyMessage: (message) => message,
      formatApprovalRejectionMessage: () => '',
    };
    const policyService: IAgentPermissionPolicyService = {
      _serviceBrand: undefined,
      evaluate: async (_ctx, options?: PermissionPolicyEvaluateOptions) =>
        options?.mode === 'manual' ? manualPolicyResult : policyResult,
    };
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.defineInstance(IAgentPermissionRulesService, stubPermissionRulesService(() => rules));
        reg.defineInstance(IAgentPermissionPolicyService, policyService);
        reg.defineInstance(IAgentToolApprovalService, toolApproval);
        reg.defineInstance(ITelemetryService, recordingTelemetry(records));
        reg.defineInstance(IAgentToolExecutorService, executorEvents.executor);
        reg.define(IAgentPermissionGate, AgentPermissionGate);
      },
      strict: true,
    });
  });
  afterEach(() => {
    disposables.dispose();
  });

  function make(): IAgentPermissionGate {
    const gate = ix.get(IAgentPermissionGate);
    disposables.add(
      gate.registerReviewer(
        createAutoReviewReviewer(
          stubFlag(() => autoReviewEnabled),
          stubPermissionModeService(() => mode),
          ix.get(IAgentPermissionPolicyService),
          { review },
        ),
      ),
    );
    return gate;
  }

  it('tracks the policy decision with the reason payload', async () => {
    policyResult = {
      policyName: 'user-configured-deny',
      result: {
        kind: 'deny',
        message: 'nope',
        reason: { matched_rule: 'Bash', match_strategy: 'literal' },
      },
    };
    make();

    await executorEvents.fireBeforeExecute(makeContext('Bash'));

    expect(records).toContainEqual({
      event: 'permission_policy_decision',
      properties: {
        turn_id: 1,
        tool_call_id: 'call-Bash',
        policy_name: 'user-configured-deny',
        tool_name: 'Bash',
        permission_mode: 'auto',
        decision: 'deny',
        matched_rule: 'Bash',
        match_strategy: 'literal',
      },
    });
  });

  it('vetoes with the resolved denial and ends adjudication on a deny resolution', async () => {
    const blocked: BeforeExecuteDecision = { veto: { output: 'nope', isError: true } };
    const resolution: PermissionPolicyResolution = { kind: 'deny', message: 'nope' };
    policyResult = { policyName: 'p', result: resolution };
    resolvePermissionResolution.mockResolvedValue(blocked);
    make();
    const later = vi.fn();
    executorEvents.executor.registerHook({ permitting: later });
    const ctx = makeContext('bash');

    const decision = await executorEvents.fireBeforeExecute(ctx);

    expect(decision).toEqual(blocked);
    expect(resolvePermissionResolution).toHaveBeenCalledWith(
      expect.objectContaining(resolution),
      expect.objectContaining({ toolCall: ctx.toolCall }),
      'p',
    );
    expect(later).not.toHaveBeenCalled();
  });

  it('defers an ask resolution to a cold waitUntil factory', async () => {
    const synthetic: BeforeExecuteDecision = { veto: { output: 'Plan review handled.' } };
    const ask: PermissionPolicyResolution = { kind: 'ask' };
    policyResult = { policyName: 'p', result: ask };
    requestToolApproval.mockResolvedValue(synthetic);
    make();
    const ctx = makeContext('ExitPlanMode');

    const decision = await executorEvents.fireBeforeExecute(ctx);

    expect(decision).toEqual(synthetic);
    expect(requestToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolCall: ctx.toolCall }),
      ask,
      'p',
    );
    expect(resolvePermissionResolution).not.toHaveBeenCalled();
  });

  it('makes no decision without a policy evaluation', async () => {
    make();

    const decision = await executorEvents.fireBeforeExecute(makeContext('bash'));

    expect(decision).toBeUndefined();
    expect(resolvePermissionResolution).not.toHaveBeenCalled();
    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('passes an approve resolution with its executionMetadata', async () => {
    const executionMetadata = { marker: true };
    policyResult = { policyName: 'p', result: { kind: 'approve', executionMetadata } };
    make();

    const decision = await executorEvents.fireBeforeExecute(makeContext('bash'));

    expect(decision).toEqual({ executionMetadata });
    expect(resolvePermissionResolution).not.toHaveBeenCalled();
  });

  it('makes no decision on a bare approve resolution', async () => {
    policyResult = { policyName: 'p', result: { kind: 'approve' } };
    make();

    const decision = await executorEvents.fireBeforeExecute(makeContext('bash'));

    expect(decision).toBeUndefined();
  });

  const fallbackAsk: PermissionPolicyEvaluation = { policyName: 'fallback-ask', result: { kind: 'ask' } };
  const modeApproval: PermissionPolicyEvaluation = { policyName: 'auto-mode-approve', result: { kind: 'approve' } };
  const allowPolicy = (policyName: string): PermissionPolicyEvaluation => ({ policyName, result: { kind: 'approve' } });
  const denyPolicy: PermissionPolicyEvaluation = { policyName: 'user-configured-deny', result: { kind: 'deny', message: 'no' } };

  function reviewModeApprovals(): void {
    autoReviewEnabled = true;
    policyResult = modeApproval;
    manualPolicyResult = fallbackAsk;
  }

  it.each([
    [false, 'yolo', 'Bash', fallbackAsk, undefined, false, 1],
    [true, 'manual', 'Bash', fallbackAsk, undefined, false, 1],
    [true, 'yolo', 'Write', fallbackAsk, undefined, false, 1],
    [true, 'yolo', 'Edit', modeApproval, fallbackAsk, false, 0],
    [true, 'yolo', 'CronCreate', modeApproval, fallbackAsk, false, 0],
    [true, 'yolo', 'Bash', denyPolicy, undefined, false, 0],
    [true, 'auto', 'Bash', modeApproval, allowPolicy('default-tool-approve'), false, 0],
    [true, 'yolo', 'Bash', modeApproval, allowPolicy('session-approval-history'), false, 0],
    [true, 'yolo', 'Bash', modeApproval, allowPolicy('user-configured-allow'), false, 0],
    [true, 'yolo', 'Bash', allowPolicy('session-approval-history'), allowPolicy('session-approval-history'), false, 0],
    [true, 'yolo', 'Bash', allowPolicy('user-configured-allow'), allowPolicy('user-configured-allow'), false, 0],
    [true, 'yolo', 'Bash', allowPolicy('user-configured-allow'), fallbackAsk, true, 0],
    [true, 'yolo', 'Bash', fallbackAsk, undefined, true, 0],
    [true, 'auto', 'Bash', modeApproval, fallbackAsk, true, 0],
    [true, 'yolo', 'mcp__fs__write_file', modeApproval, fallbackAsk, true, 0],
    [true, 'auto', 'mcp__fs__write_file', fallbackAsk, undefined, true, 0],
  ] satisfies Array<[boolean, PermissionMode, string, PermissionPolicyEvaluation, PermissionPolicyEvaluation | undefined, boolean, number]>)(
    'reviews tool=%s mode=%s policy=%s -> %s',
    async (enabled, nextMode, tool, policy, manualPolicy, expected, expectedHumanAsks) => {
      autoReviewEnabled = enabled;
      mode = nextMode;
      policyResult = policy;
      manualPolicyResult = manualPolicy;
      make();

      await executorEvents.fireBeforeExecute(makeContext(tool));

      expect(review).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(requestToolApproval).toHaveBeenCalledTimes(expectedHumanAsks);
    },
  );

  it('passes the asking policy name and routes a denial back to approval in Ask When Needed', async () => {
    policyResult = { policyName: 'sensitive-file-access-ask', result: { kind: 'ask' } };
    autoReviewOutcome = { decision: 'deny', risk: 'high' };
    autoReviewEnabled = true;
    mode = 'yolo';
    make();

    await executorEvents.fireBeforeExecute(makeContext('Bash'));

    expect(review).toHaveBeenCalledWith(expect.anything(), 'sensitive-file-access-ask');
    expect(resolvePermissionResolution).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ask' }),
      expect.anything(),
      'auto-review',
    );
  });

  it('defers asks and skips review when another listener vetoes or finally allows', async () => {
    reviewModeApprovals();
    const blocked: BeforeExecuteDecision = { veto: { output: 'hook denied', isError: true } };
    make();
    let outcome: 'veto' | 'allow' = 'veto';
    executorEvents.executor.registerLegacyStarting((event) => {
      if (outcome === 'veto') event.veto(blocked.veto!);
      else event.allow();
    });

    expect(await executorEvents.fireBeforeExecute(makeContext('Bash'))).toEqual(blocked);
    outcome = 'allow';
    expect(await executorEvents.fireBeforeExecute(makeContext('Bash'))).toEqual({ allow: true });
    expect(review).not.toHaveBeenCalled();
    expect(requestToolApproval).not.toHaveBeenCalled();

    policyResult = fallbackAsk;
    autoReviewEnabled = false;
    outcome = 'veto';
    expect(await executorEvents.fireBeforeExecute(makeContext('Write'))).toEqual(blocked);
    expect(requestToolApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['yolo', 'yolo', 'deny', 'ask'],
    ['yolo', 'yolo', 'failed', 'ask'],
    ['auto', 'auto', 'deny', 'deny'],
    ['auto', 'auto', 'failed', 'deny'],
    ['auto', 'yolo', 'deny', 'ask'],
    ['yolo', 'auto', 'deny', 'deny'],
    ['auto', 'manual', 'deny', 'ask'],
    ['auto', 'manual', 'allow', 'ask'],
  ] as const)('resolves a %s review started in %s and finished in %s as %s', async (from, to, outcome, expected) => {
    reviewModeApprovals();
    mode = from;
    review.mockImplementation(async () => {
      mode = to;
      if (outcome === 'failed') return { decision: 'failed', reason: 'invalid JSON' };
      return outcome === 'allow' ? { decision: 'allow', risk: 'low' } : { decision: 'deny', risk: 'high' };
    });
    make();

    await executorEvents.fireBeforeExecute(makeContext('Bash'));

    expect(resolvePermissionResolution).toHaveBeenCalledWith(
      expect.objectContaining({ kind: expected }),
      expect.anything(),
      'auto-review',
    );
  });

  it('lets the user override a review denial in Ask When Needed and explains it without a user', () => {
    const onUnderlyingApproved = vi.fn(() => undefined);
    const { result } = resolveAutoReview(
      makeContext('Bash'),
      modeApproval,
      { kind: 'ask', reason: { executable_name: 'ssh' }, resolveApproval: onUnderlyingApproved },
      { decision: 'deny', risk: 'high', reason: 'Too broad.' },
      'yolo',
    );

    expect(result).toMatchObject({
      kind: 'ask',
      approvalDetail: { outcome: 'denied', risk: 'high', reason: 'Too broad.' },
      reason: { executable_name: 'ssh', review_risk: 'high' },
    });
    if (result.kind !== 'ask') return;
    expect(result.resolveApproval?.({ decision: 'approved' })).toBeUndefined();
    expect(onUnderlyingApproved).toHaveBeenCalledWith({ decision: 'approved' });
    expect(result.resolveApproval?.({ decision: 'rejected' })).toMatchObject({
      kind: 'deny', message: expect.stringContaining('Too broad.'),
    });
    expect(result.resolveApproval?.({ decision: 'rejected', feedback: 'Only delete generated/.' })).toMatchObject({
      kind: 'deny', message: expect.stringContaining('Reason: Only delete generated/.'),
    });
    expect(result.resolveNonInteractive?.()).toMatchObject({
      kind: 'deny', message: expect.stringContaining('Too broad.'),
    });
  });

  it('data() reflects the mode and rules services', () => {
    mode = 'yolo';
    rules = [{ decision: 'allow', scope: 'user', pattern: 'Bash(*)' }];
    const svc = make();
    expect(svc.data()).toEqual({ mode: 'yolo', rules });
  });
});
