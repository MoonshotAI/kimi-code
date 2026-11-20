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
import type { PermissionPolicyEvaluation } from '#/agent/permissionPolicy/permissionPolicy';
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
  autoReviewTrigger,
  createAutoReviewReviewer,
  resolveAutoReview,
} from '#/features/autoReview/autoReviewGate';
import {
  type AutoReviewResult,
  type IAutoReviewService,
} from '#/features/autoReview/review';
import type { ToolCall } from '#human/message';

import { stubFlag } from '../../app/flag/stubs';

import { stubPermissionModeService } from '../permissionMode/stubs';
import { stubPermissionPolicyService } from '../permissionPolicy/stubs';
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
  let autoReviewEnabled: boolean;
  let autoReviewResult: AutoReviewResult;
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
    autoReviewEnabled = false;
    autoReviewResult = { kind: 'decision', decision: { risk: 'low', decision: 'allow' } };
    review = vi.fn(async () => autoReviewResult);
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
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.defineInstance(IAgentPermissionRulesService, stubPermissionRulesService(() => rules));
        reg.defineInstance(
          IAgentPermissionPolicyService,
          stubPermissionPolicyService(() => policyResult),
        );
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
          () => ({ _serviceBrand: undefined, review }),
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

  it('defers a static ask until every listener has voted', async () => {
    policyResult = { policyName: 'p', result: { kind: 'ask' } };
    const blocked: BeforeExecuteDecision = { veto: { output: 'hook denied', isError: true } };
    make();
    executorEvents.executor.registerLegacyStarting((event) => {
      event.veto(blocked.veto!);
    });

    expect(await executorEvents.fireBeforeExecute(makeContext('Write'))).toEqual(blocked);
    expect(requestToolApproval).not.toHaveBeenCalled();
  });

  const fallbackAsk: PermissionPolicyEvaluation = { policyName: 'fallback-ask', result: { kind: 'ask' } };
  const modeApproval: PermissionPolicyEvaluation = {
    policyName: 'auto-mode-approve',
    result: { kind: 'approve' },
    underlying: fallbackAsk,
  };

  function reviewModeApprovals(): void {
    autoReviewEnabled = true;
    policyResult = modeApproval;
  }

  it('reviews only mode approvals that Always Ask would ask about', () => {
    expect(autoReviewTrigger(false, mode, modeApproval)).toBeUndefined();
    expect(autoReviewTrigger(true, mode, modeApproval)).toBe('fallback-ask');
    for (const evaluation of [
      { policyName: 'user-configured-allow', result: { kind: 'approve' } },
      { policyName: 'session-approval-history', result: { kind: 'approve' } },
      { policyName: 'user-configured-deny', result: { kind: 'deny' } },
    ] satisfies PermissionPolicyEvaluation[]) {
      expect(autoReviewTrigger(true, mode, evaluation)).toBeUndefined();
    }
    for (const policyName of ['default-tool-approve', 'git-cwd-write-approve', 'user-configured-allow']) {
      expect(autoReviewTrigger(true, mode, {
        ...modeApproval,
        underlying: { policyName, result: { kind: 'approve' } },
      })).toBeUndefined();
    }
  });

  it('reviews a static ask before falling back to the user in Ask When Needed', async () => {
    autoReviewEnabled = true;
    mode = 'yolo';
    policyResult = { policyName: 'sensitive-file-access-ask', result: { kind: 'ask' } };
    autoReviewResult = { kind: 'decision', decision: { risk: 'high', decision: 'deny' } };
    make();

    await executorEvents.fireBeforeExecute(makeContext('Bash'));

    expect(review).toHaveBeenCalledWith(expect.anything(), 'sensitive-file-access-ask', expect.any(AbortSignal));
    expect(resolvePermissionResolution).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ask' }),
      expect.anything(),
      'auto-review',
    );
  });

  it('approves a static ask after a reviewer allow in Ask When Needed', async () => {
    autoReviewEnabled = true;
    mode = 'yolo';
    policyResult = { policyName: 'sensitive-file-access-ask', result: { kind: 'ask' } };
    make();

    await executorEvents.fireBeforeExecute(makeContext('Bash'));

    expect(review).toHaveBeenCalledTimes(1);
    expect(requestToolApproval).not.toHaveBeenCalled();
    expect(resolvePermissionResolution).toHaveBeenCalledWith(
      { kind: 'approve', reason: { review_risk: 'low' }, executionMetadata: undefined },
      expect.anything(),
      'auto-review',
    );
    expect(records).toContainEqual({
      event: 'permission_policy_decision',
      properties: {
        turn_id: 1,
        tool_call_id: 'call-Bash',
        policy_name: 'auto-review',
        tool_name: 'Bash',
        permission_mode: 'yolo',
        decision: 'approve',
        review_risk: 'low',
      },
    });
  });

  it('keeps static asks on the user path when review is disabled or the mode is Always Ask', async () => {
    for (const [enabled, nextMode] of [[false, 'yolo'], [true, 'manual']] as const) {
      autoReviewEnabled = enabled;
      mode = nextMode;
      policyResult = { policyName: 'sensitive-file-access-ask', result: { kind: 'ask' } };
      make();

      await executorEvents.fireBeforeExecute(makeContext('Bash'));

      expect(review).not.toHaveBeenCalled();
      expect(requestToolApproval).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();
    }
  });

  it('reviews ordinary yolo approvals before the user fallback', () => {
    expect(autoReviewTrigger(true, 'yolo', {
      policyName: 'yolo-mode-approve',
      result: { kind: 'approve' },
      underlying: fallbackAsk,
    })).toBe('fallback-ask');
  });

  it('passes the asking policy to the reviewer', async () => {
    reviewModeApprovals();
    make();
    const ctx = makeContext('Bash');

    await executorEvents.fireBeforeExecute(ctx);

    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({ toolCall: ctx.toolCall }),
      'fallback-ask',
      expect.any(AbortSignal),
    );
  });

  it('does not review when another listener vetoes or finally allows', async () => {
    reviewModeApprovals();
    make();
    let outcome: 'veto' | 'allow' = 'veto';
    executorEvents.executor.registerLegacyStarting((event) => {
      if (outcome === 'veto') event.veto({ output: 'hook denied', isError: true });
      else event.allow();
    });

    await executorEvents.fireBeforeExecute(makeContext('Bash'));
    outcome = 'allow';
    expect(await executorEvents.fireBeforeExecute(makeContext('Bash'))).toEqual({ allow: true });

    expect(review).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'yolo', expected: 'ask' },
    { mode: 'auto', expected: 'deny' },
  ] as const)('maps reviewer denial and failure to $expected in $mode', ({ mode: nextMode, expected }) => {
    expect(resolveAutoReview(
      makeContext('Bash'),
      modeApproval,
      { kind: 'decision', decision: { risk: 'high', decision: 'deny' } },
      nextMode,
    )).toMatchObject({
      policyName: 'auto-review',
      result: { kind: expected },
    });
    expect(resolveAutoReview(
      makeContext('Bash'),
      modeApproval,
      { kind: 'failed', reason: 'invalid JSON' },
      nextMode,
    )).toMatchObject({
      policyName: 'auto-review',
      result: { kind: expected },
    });
  });

  it.each([
    { from: 'auto', to: 'manual', expected: 'ask' },
    { from: 'auto', to: 'yolo', expected: 'ask' },
    { from: 'yolo', to: 'auto', expected: 'deny' },
  ] as const)('uses $to when reviewer denial finishes after a mode switch', async ({ from, to, expected }) => {
    reviewModeApprovals();
    mode = from;
    autoReviewResult = { kind: 'decision', decision: { risk: 'high', decision: 'deny' } };
    review.mockImplementation(async () => {
      mode = to;
      return autoReviewResult;
    });
    make();

    await executorEvents.fireBeforeExecute(makeContext('Bash'));

    expect(resolvePermissionResolution).toHaveBeenCalledWith(
      expect.objectContaining({ kind: expected }),
      expect.anything(),
      'auto-review',
    );
  });

  it('asks when Never Ask changes to Always Ask after a reviewer allow', async () => {
    reviewModeApprovals();
    review.mockImplementation(async () => {
      mode = 'manual';
      return autoReviewResult;
    });
    make();

    await executorEvents.fireBeforeExecute(makeContext('Bash'));

    expect(resolvePermissionResolution).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ask' }),
      expect.anything(),
      'auto-review',
    );
  });

  it('asks when Auto Review is disabled while a review is pending', async () => {
    reviewModeApprovals();
    review.mockImplementation(async () => {
      autoReviewEnabled = false;
      return autoReviewResult;
    });
    make();

    await executorEvents.fireBeforeExecute(makeContext('Bash'));

    expect(resolvePermissionResolution).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ask' }),
      expect.anything(),
      'auto-review',
    );
  });

  it('does not consult the reviewer after a static denial', async () => {
    autoReviewEnabled = true;
    policyResult = { policyName: 'user-configured-deny', result: { kind: 'deny', message: 'nope' } };
    make();

    await executorEvents.fireBeforeExecute(makeContext('Bash'));

    expect(review).not.toHaveBeenCalled();
  });

  it('vetoes a mode-approved call denied in Never Ask', async () => {
    reviewModeApprovals();
    autoReviewResult = { kind: 'decision', decision: { risk: 'high', decision: 'deny' } };
    const blocked: BeforeExecuteDecision = { veto: { output: 'review denied', isError: true } };
    resolvePermissionResolution.mockResolvedValue(blocked);
    make();
    const ctx = makeContext('Bash');

    expect(await executorEvents.fireBeforeExecute(ctx)).toEqual(blocked);
    expect(resolvePermissionResolution).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'deny' }),
      expect.objectContaining({ toolCall: ctx.toolCall }),
      'auto-review',
    );
  });

  it('lets the user override a review denial in Ask When Needed and explains it without a user', () => {
    const { result } = resolveAutoReview(
      makeContext('Bash'),
      modeApproval,
      { kind: 'decision', decision: { risk: 'high', decision: 'deny', reason: 'Too broad.' } },
      'yolo',
    );

    expect(result.kind).toBe('ask');
    if (result.kind !== 'ask') return;
    expect(result.resolveApproval?.({ decision: 'approved' })).toBeUndefined();
    expect(result.resolveApproval?.({ decision: 'rejected' })).toMatchObject({
      kind: 'deny',
      message: expect.stringContaining('Too broad.'),
    });
    expect(result.resolveApproval?.({
      decision: 'rejected',
      feedback: 'Only delete generated/.',
    })).toMatchObject({
      kind: 'deny',
      message: expect.stringContaining('Reason: Only delete generated/.'),
    });
    expect(result.resolveNonInteractive?.()).toMatchObject({
      kind: 'deny',
      message: expect.stringContaining('Too broad.'),
    });
  });

  it('data() reflects the mode and rules services', () => {
    mode = 'yolo';
    rules = [{ decision: 'allow', scope: 'user', pattern: 'Bash(*)' }];
    const svc = make();
    expect(svc.data()).toEqual({ mode: 'yolo', rules });
  });
});
