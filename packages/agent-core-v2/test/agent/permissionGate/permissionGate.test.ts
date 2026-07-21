import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import type {
  AuthorizeToolExecutionResult,
  ResolvedToolExecutionHookContext,
  ToolBeforeExecuteContext,
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
import { stubToolExecutor } from '../loop/stubs';

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
  let executor: ReturnType<typeof stubToolExecutor>;
  let resolvePermissionResolution: ReturnType<
    typeof vi.fn<IAgentToolApprovalService['resolvePermissionResolution']>
  >;

  beforeEach(() => {
    disposables = new DisposableStore();
    mode = 'auto';
    rules = [];
    policyResult = undefined;
    records = [];
    executor = stubToolExecutor();
    resolvePermissionResolution = vi.fn(async () => undefined);
    const toolApproval: IAgentToolApprovalService = {
      _serviceBrand: undefined,
      resolvePermissionResolution,
      requestToolApproval: vi.fn(async () => undefined),
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
        reg.defineInstance(IAgentToolExecutorService, executor);
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
    const blocked: AuthorizeToolExecutionResult = { block: true, reason: 'nope' };
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

  it('writes the decision into the hook context and stops the chain on block', async () => {
    const blocked: AuthorizeToolExecutionResult = { block: true, reason: 'nope' };
    policyResult = { policyName: 'p', result: { kind: 'deny', message: 'nope' } };
    resolvePermissionResolution.mockResolvedValue(blocked);
    make();
    const ctx: ToolBeforeExecuteContext = makeContext('bash');
    const terminal = vi.fn(async () => {});

    await executor.hooks.onBeforeExecuteTool.run(ctx, terminal);

    expect(ctx.decision).toBe(blocked);
    expect(terminal).not.toHaveBeenCalled();
  });

  it('stops the chain on a synthetic result', async () => {
    const synthetic: AuthorizeToolExecutionResult = {
      syntheticResult: { output: 'Plan review handled.' },
    };
    policyResult = { policyName: 'p', result: { kind: 'ask' } };
    resolvePermissionResolution.mockResolvedValue(synthetic);
    make();
    const ctx: ToolBeforeExecuteContext = makeContext('ExitPlanMode');
    const terminal = vi.fn(async () => {});

    await executor.hooks.onBeforeExecuteTool.run(ctx, terminal);

    expect(ctx.decision).toBe(synthetic);
    expect(terminal).not.toHaveBeenCalled();
  });

  it.each([
    ['no decision', undefined],
    ['approve with executionMetadata', { executionMetadata: { marker: true } }],
  ] as const)('continues the chain on %s', async (_name, result) => {
    policyResult = { policyName: 'p', result: { kind: 'approve' } };
    resolvePermissionResolution.mockResolvedValue(result);
    make();
    const ctx: ToolBeforeExecuteContext = makeContext('bash');
    const terminal = vi.fn(async () => {});

    await executor.hooks.onBeforeExecuteTool.run(ctx, terminal);

    if (result === undefined) {
      expect(ctx.decision).toBeUndefined();
    } else {
      expect(ctx.decision).toBe(result);
    }
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it('data() reflects the mode and rules services', () => {
    mode = 'yolo';
    rules = [{ decision: 'allow', scope: 'user', pattern: 'Bash(*)' }];
    const svc = make();
    expect(svc.data()).toEqual({ mode: 'yolo', rules });
  });
});
