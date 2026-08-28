import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';
import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/features/toolExecutor/toolHooks';
import type { PermissionPolicyEvaluation } from '#/features/toolExecutor/internal/permissionPolicy';
import type { ToolExecutionPermissionPolicyChain } from '#/features/toolExecutor/internal/permissionPolicy';
import { ToolExecutionPermissionGatePolicy } from '#/features/toolExecutor/internal/permissionGate';
import type { PermissionMode, PermissionPolicyResolution } from '#/features/toolExecutor/permissionTypes';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { ISessionToolApprovalService } from '#/agent/toolApproval/sessionToolApprovalService';
import { IAgentHostService } from '#/agent/host/agentHost';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { AgentPermissionMode } from '#/features/permissionMode/permissionModeAgentRuntime';
import { AgentPermissionRules } from '#/features/permissionRules/permissionRulesAgentRuntime';
import type { PermissionRule } from '#/features/permissionRules/types';
import type { ToolCall } from '#/kosong/contract/message';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { stubPermissionRulesRuntime } from '../../features/permissionRules/stubs';
import { stubPermissionModeRuntime } from '../../features/permissionMode/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubToolExecutorEvents, type ToolExecutorEventStubs } from './stubs';

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

describe('ToolExecutionPermissionGatePolicy', () => {
  let disposables: DisposableStore;
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
  });
  afterEach(() => {
    disposables.dispose();
  });

  function make(): ToolExecutionPermissionGatePolicy {
    const toolApproval: IAgentToolApprovalService = {
      _serviceBrand: undefined,
      resolvePermissionResolution,
      requestToolApproval,
      formatDenyMessage: (message) => message,
      formatApprovalRejectionMessage: () => '',
    };
    const lifecycle = {
      resolve: (_agent: unknown, definition: unknown) => {
        if (definition === AgentPermissionRules) {
          return stubPermissionRulesRuntime({ rules: () => rules });
        }
        if (definition === AgentPermissionMode) return stubPermissionModeRuntime(() => mode);
        throw new Error('unexpected resolve');
      },
    } as unknown as IAgentLifecycleService;
    const context: AgentRuntimeContext<unknown> = {
      agent: { agentId: 'main', generation: 1 } as AgentContext,
      get: (id) => {
        if (id === IAgentLifecycleService) return lifecycle as never;
        if (id === IAgentToolApprovalService) return toolApproval as never;
        if (id === ISessionToolApprovalService) return { of: () => toolApproval } as never;
        if (id === ITelemetryService) return recordingTelemetry(records) as never;
        if (id === IAgentHostService) {
          return { of: () => ({ telemetry: recordingTelemetry(records) }) } as never;
        }
        throw new Error('unexpected get');
      },
      getState: () => {
        throw new Error('no durable state');
      },
      getLogicState: () => {
        throw new Error('no logic state');
      },
      dispatch: () => Promise.resolve(),
      send: () => {},
      onDidChange: Event.None,
    };
    const chain = {
      evaluate: () => Promise.resolve(policyResult),
    } as unknown as ToolExecutionPermissionPolicyChain;
    const gate = new ToolExecutionPermissionGatePolicy(context, chain);
    executorEvents.beforeBus.register('permissionGate', (event) => gate.adjudicate(event), 'postPolicy');
    return gate;
  }

  it('vetoes with the resolved denial and ends adjudication on a deny resolution', async () => {
    const blocked: BeforeExecuteDecision = { veto: { output: 'nope', isError: true } };
    policyResult = { policyName: 'p', result: { kind: 'deny', message: 'nope' } };
    resolvePermissionResolution.mockResolvedValue(blocked);
    make();
    const later = vi.fn();
    executorEvents.executor.participateExecution('later', later, 'postPolicy');

    const decision = await executorEvents.fireBeforeExecute(makeContext('bash'));

    expect(decision).toEqual(blocked);
    expect(later).not.toHaveBeenCalled();
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
});
