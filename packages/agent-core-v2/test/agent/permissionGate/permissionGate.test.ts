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
import type { ToolCall } from '#/kosong/contract/message';

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
    return ix.get(IAgentPermissionGate);
  }

  it('returns undefined without consulting approvals when no policy evaluates', async () => {
    const svc = make();

    expect(await svc.authorize(makeContext('bash'))).toBeUndefined();
    expect(resolvePermissionResolution).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('forwards the policy resolution to the approval service and returns its result', async () => {
    const resolution: PermissionPolicyResolution = { kind: 'deny', message: 'nope' };
    policyResult = { policyName: 'user-configured-deny', result: resolution };
    const blocked: BeforeExecuteDecision = { veto: { output: 'nope', isError: true } };
    resolvePermissionResolution.mockResolvedValue(blocked);
    const svc = make();
    const ctx = makeContext('bash');

    expect(await svc.authorize(ctx)).toBe(blocked);
    expect(resolvePermissionResolution).toHaveBeenCalledWith(
      resolution,
      ctx,
      'user-configured-deny',
    );
  });

  it('passes an approve result with executionMetadata straight through', async () => {
    const executionMetadata = { marker: true };
    policyResult = { policyName: 'p', result: { kind: 'approve', executionMetadata } };
    resolvePermissionResolution.mockResolvedValue({ executionMetadata });
    const svc = make();

    expect(await svc.authorize(makeContext('bash'))).toEqual({ executionMetadata });
  });

  it('tracks the policy decision with the reason payload', async () => {
    policyResult = {
      policyName: 'user-configured-deny',
      result: {
        kind: 'deny',
        message: 'nope',
        reason: { matched_rule: 'Bash', match_strategy: 'literal' },
      },
    };
    const svc = make();

    await svc.authorize(makeContext('Bash'));

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
    policyResult = { policyName: 'p', result: { kind: 'deny', message: 'nope' } };
    resolvePermissionResolution.mockResolvedValue(blocked);
    make();
    const later = vi.fn();
    executorEvents.executor.onBeforeExecuteTool(later);

    const decision = await executorEvents.fireBeforeExecute(makeContext('bash'));

    expect(decision).toEqual(blocked);
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

  it('data() reflects the mode and rules services', () => {
    mode = 'yolo';
    rules = [{ decision: 'allow', scope: 'user', pattern: 'Bash(*)' }];
    const svc = make();
    expect(svc.data()).toEqual({ mode: 'yolo', rules });
  });
});
