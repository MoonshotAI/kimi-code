import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import {
  ISessionApprovalService,
  type ApprovalRequest,
  type ApprovalResponse,
} from '#/session/approval/approval';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { AgentPermissionGate } from '#/agent/permissionGate/permissionGateService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionPolicyEvaluation } from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import { AgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicyService';
import {
  IAgentPermissionRulesService,
  type PermissionApprovalResultRecord,
  type PermissionRule,
} from '#/agent/permissionRules/permissionRules';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ToolCall } from '#/kosong/contract/message';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { stubApprovalService } from '../../session/approval/stubs';
import { stubPermissionModeService } from '../permissionMode/stubs';
import { stubPermissionPolicyService } from '../permissionPolicy/stubs';
import { stubPermissionRulesService } from '../permissionRules/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubToolExecutor } from '../loop/stubs';

function makeContext(
  toolName: string,
  args: Record<string, unknown> = {},
  display?: ToolInputDisplay,
  traceId?: string,
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
    trace: { traceId },
    toolCall,
    toolCalls: [toolCall],
    args,
    execution: {
      description: `Approve ${toolName}`,
      approvalRule: toolName,
      display,
      execute: () => Promise.resolve({ output: '' }),
    },
  };
}

function planReviewDisplay(): ToolInputDisplay {
  return {
    kind: 'plan_review',
    plan: '# Plan',
    path: '/tmp/kimi-plan.md',
  };
}

describe('AgentPermissionGate', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let rules: readonly PermissionRule[];
  let policyResult: PermissionPolicyEvaluation | undefined;
  let approvalResponse: ApprovalResponse;
  let eventBus: IEventBus;

  beforeEach(() => {
    disposables = new DisposableStore();
    eventBus = disposables.add(new EventBusService());
    mode = 'auto';
    rules = [];
    policyResult = undefined;
    approvalResponse = { decision: 'approved' };
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.defineInstance(IAgentPermissionRulesService, stubPermissionRulesService(() => rules));
        reg.defineInstance(
          IAgentPermissionPolicyService,
          stubPermissionPolicyService(() => policyResult),
        );
        reg.defineInstance(IEventBus, eventBus);
        reg.definePartialInstance(ITelemetryService, { track: () => {}, track2: () => {} });
        reg.defineInstance(ISessionApprovalService, stubApprovalService(() => approvalResponse));
        reg.defineInstance(ISessionContext, makeSessionContext({
          sessionId: 'test-session',
          workspaceId: 'test-workspace',
          sessionDir: '/tmp/test-session',
          sessionScope: 'sessions/test-workspace/test-session',
          metaScope: 'sessions/test-workspace/test-session/session-meta',
          cwd: '/tmp/test-session',
        }));
        reg.definePartialInstance(IAgentPlanService, {
          status: async () => null,
          exit: () => {},
        });
        reg.definePartialInstance(IAgentSwarmService, {
          isActive: false,
        });
        reg.definePartialInstance(IHostEnvironment, {
          pathClass: 'posix',
        });
        reg.definePartialInstance(ISessionWorkspaceContext, {
          workDir: '/workspace',
          additionalDirs: [],
        });
        reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
        reg.define(IEventBus, EventBusService);
        reg.defineInstance(IAgentScopeContext, {
          _serviceBrand: undefined,
          agentId: 'main',
          scope: (subKey?: string): string => (subKey ? `main/${subKey}` : 'main'),
        });
        reg.definePartialInstance(IAgentProfileService, {
          data: () => ({ cwd: '/workspace' }) as ProfileData,
        });
      },
    });
  });
  afterEach(() => {
    disposables.dispose();
  });

  function make(): IAgentPermissionGate {
    ix.set(IAgentPermissionGate, new SyncDescriptor(AgentPermissionGate));
    return ix.get(IAgentPermissionGate);
  }

  function useRealPolicyService(): void {
    ix.set(IAgentPermissionPolicyService, new SyncDescriptor(AgentPermissionPolicyService));
  }

  function setApprovalRequest(
    request: (approval: ApprovalRequest) => Promise<ApprovalResponse>,
  ): ReturnType<typeof vi.fn<(approval: ApprovalRequest) => Promise<ApprovalResponse>>> {
    const requestSpy = vi.fn(request);
    ix.set(ISessionApprovalService, {
      _serviceBrand: undefined,
      request: requestSpy,
      enqueue: (approval) => ({ ...approval, id: approval.id ?? 'approval-1' }),
      decide: () => {},
      listPending: () => [],
    });
    return requestSpy;
  }

  function recordTelemetry(): TelemetryRecord[] {
    const records: TelemetryRecord[] = [];
    ix.set(ITelemetryService, recordingTelemetry(records));
    return records;
  }

  it('returns undefined when no policy evaluates', async () => {
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toBeUndefined();
  });

  it('maps an approve decision to undefined', async () => {
    policyResult = { policyName: 'p', result: { kind: 'approve' } };
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toBeUndefined();
  });

  it('passes executionMetadata through on approve', async () => {
    const executionMetadata = { marker: true };
    policyResult = {
      policyName: 'p',
      result: { kind: 'approve', executionMetadata },
    };
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toEqual({ executionMetadata });
  });

  it('maps a deny decision to a block with the policy message', async () => {
    policyResult = { policyName: 'p', result: { kind: 'deny', message: 'nope' } };
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toEqual({
      block: true,
      reason: 'nope',
    });
  });

  it('adds subagent retry guidance to policy deny messages', async () => {
    policyResult = { policyName: 'p', result: { kind: 'deny', message: 'nope' } };
    ix.set(IAgentScopeContext, {
      _serviceBrand: undefined,
      agentId: 'sub-1',
      scope: (subKey?: string): string => (subKey ? `sub-1/${subKey}` : 'sub-1'),
    });
    const svc = make();
    const retryGuidance =
      "Try a different approach — don't retry the same call, don't attempt to bypass the restriction.";

    expect(await svc.authorize(makeContext('bash'))).toEqual({
      block: true,
      reason: `nope ${retryGuidance}`,
    });
  });

  it('uses a default reason when a deny has no message', async () => {
    policyResult = { policyName: 'p', result: { kind: 'deny' } };
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toEqual({
      block: true,
      reason: 'Tool "bash" was denied by permission policy.',
    });
  });

  it('maps an approved ask to undefined', async () => {
    policyResult = { policyName: 'p', result: { kind: 'ask' } };
    approvalResponse = { decision: 'approved' };
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toBeUndefined();
  });

  it('maps a rejected ask to a block', async () => {
    policyResult = { policyName: 'p', result: { kind: 'ask' } };
    approvalResponse = { decision: 'rejected' };
    const svc = make();
    expect(await svc.authorize(makeContext('bash'))).toEqual({
      block: true,
      reason: 'Tool "bash" was not run because the user rejected the approval request.',
    });
  });

  it('data() reflects the mode and rules services', () => {
    mode = 'yolo';
    rules = [{ decision: 'allow', scope: 'user', pattern: 'Bash(*)' }];
    const svc = make();
    expect(svc.data()).toEqual({ mode: 'yolo', rules });
  });

  it.each([
    ['Read', { path: '/workspace/notes.md' }],
    ['Grep', { pattern: 'TODO', path: '/workspace' }],
    ['Glob', { pattern: '**/*.ts', path: '/workspace' }],
    ['ReadMediaFile', { path: '/workspace/image.png' }],
    ['SetTodoList', { items: [] }],
    ['TodoList', {}],
    ['TaskList', {}],
    ['TaskOutput', { task_id: 'task_1' }],
    ['CronList', {}],
    ['WebSearch', { query: 'kimi code' }],
    ['FetchURL', { url: 'https://example.com' }],
    ['Agent', { prompt: 'review this' }],
    ['AskUserQuestion', { questions: [] }],
    ['Skill', { name: 'test-skill' }],
  ] as const)(
    'does not request approval for default-approved %s in manual mode',
    async (toolName, args) => {
      mode = 'manual';
      useRealPolicyService();
      const request = setApprovalRequest(async () => ({ decision: 'approved' }));
      const svc = make();

      await expect(svc.authorize(makeContext(toolName, args))).resolves.toBeUndefined();

      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Bash', { command: 'printf first', timeout: 60 }],
    ['Write', { path: '/workspace/a.ts', content: 'x' }],
    ['Edit', { path: '/workspace/a.ts', old_string: 'a', new_string: 'b' }],
    ['Custom', { value: 1 }],
  ] as const)(
    'requests approval for non-default %s in manual mode',
    async (toolName, args) => {
      mode = 'manual';
      useRealPolicyService();
      const request = setApprovalRequest(async () => ({ decision: 'approved' }));
      const svc = make();

      await expect(svc.authorize(makeContext(toolName, args))).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps auto-mode AskUserQuestion deny above default approval', async () => {
    mode = 'auto';
    useRealPolicyService();
    const request = setApprovalRequest(async () => ({ decision: 'approved' }));
    const records = recordTelemetry();
    const svc = make();

    await expect(
      svc.authorize(makeContext('AskUserQuestion', { questions: [] })),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('AskUserQuestion is disabled'),
    });

    expect(request).not.toHaveBeenCalled();
    expect(records).toContainEqual({
      event: 'permission_policy_decision',
      properties: expect.objectContaining({
        policy_name: 'auto-mode-ask-user-question-deny',
        tool_name: 'AskUserQuestion',
        decision: 'deny',
      }),
    });
  });

  it('turns approved session-scoped responses into an agent-local runtime rule cache', async () => {
    mode = 'manual';
    const sessionApprovalRulePatterns: string[] = [];
    const recorded: PermissionApprovalResultRecord[] = [];
    ix.set(IAgentPermissionRulesService, mutablePermissionRulesService({
      rules: () => [],
      sessionApprovalRulePatterns: () => sessionApprovalRulePatterns,
      record: (record) => {
        recorded.push(record);
        if (record.sessionApprovalRule !== undefined) {
          sessionApprovalRulePatterns.push(record.sessionApprovalRule);
        }
      },
    }));
    useRealPolicyService();
    const request = setApprovalRequest(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    const records = recordTelemetry();
    const svc = make();

    await expect(svc.authorize(makeContext('Custom', { query: 'first' }))).resolves
      .toBeUndefined();
    await expect(svc.authorize(makeContext('Custom', { query: 'second' }))).resolves
      .toBeUndefined();

    expect(request).toHaveBeenCalledTimes(1);
    expect(recorded[0]).toMatchObject({
      toolName: 'Custom',
      sessionApprovalRule: 'Custom',
      result: { decision: 'approved', scope: 'session' },
    });
    expect(sessionApprovalRulePatterns).toEqual(['Custom']);
    expect(records).toContainEqual({
      event: 'permission_policy_decision',
      properties: expect.objectContaining({
        policy_name: 'session-approval-history',
        tool_name: 'Custom',
        decision: 'approve',
      }),
    });
  });

  it('keeps approved-once responses one-shot', async () => {
    mode = 'manual';
    const recorded: PermissionApprovalResultRecord[] = [];
    ix.set(IAgentPermissionRulesService, mutablePermissionRulesService({
      rules: () => [],
      sessionApprovalRulePatterns: () => [],
      record: (record) => recorded.push(record),
    }));
    useRealPolicyService();
    const request = setApprovalRequest(async () => ({ decision: 'approved' }));
    const svc = make();

    await expect(svc.authorize(makeContext('Custom', { query: 'first' }))).resolves
      .toBeUndefined();
    await expect(svc.authorize(makeContext('Custom', { query: 'second' }))).resolves
      .toBeUndefined();

    expect(request).toHaveBeenCalledTimes(2);
    expect(recorded).toHaveLength(2);
    expect(recorded.every((record) => record.sessionApprovalRule === undefined)).toBe(true);
  });

  it('publishes approval events while waiting for user approval', async () => {
    const permissionRequest = vi.fn();
    const permissionResult = vi.fn();
    policyResult = { policyName: 'p', result: { kind: 'ask' } };
    approvalResponse = { decision: 'approved', selectedLabel: 'Approve once' };
    const request = setApprovalRequest(async () => approvalResponse);
    const svc = make();
    const eventBus = ix.get(IEventBus);
    disposables.add(
      eventBus.subscribe('permission.approval.requested', permissionRequest),
    );
    disposables.add(
      eventBus.subscribe('permission.approval.resolved', permissionResult),
    );

    await expect(svc.authorize(makeContext('Bash', { command: 'printf first' }))).resolves
      .toBeUndefined();

    expect(request).toHaveBeenCalledTimes(1);
    expect(permissionRequest).toHaveBeenCalledWith({
      type: 'permission.approval.requested',
      sessionId: 'test-session',
      agentId: 'main',
      turnId: 1,
      toolCallId: 'call-Bash',
      toolName: 'Bash',
      action: 'Approve Bash',
      toolInput: { command: 'printf first' },
      display: {
        kind: 'generic',
        summary: 'Approve Bash',
        detail: { command: 'printf first' },
      },
    });
    expect(permissionResult).toHaveBeenCalledWith({
      type: 'permission.approval.resolved',
      sessionId: 'test-session',
      agentId: 'main',
      turnId: 1,
      toolCallId: 'call-Bash',
      toolName: 'Bash',
      action: 'Approve Bash',
      toolInput: { command: 'printf first' },
      display: {
        kind: 'generic',
        summary: 'Approve Bash',
        detail: { command: 'printf first' },
      },
      decision: 'approved',
      selectedLabel: 'Approve once',
    });
  });

  it('tracks cancelled approval requests', async () => {
    mode = 'manual';
    policyResult = { policyName: 'fallback-ask', result: { kind: 'ask' } };
    approvalResponse = { decision: 'cancelled', feedback: 'request closed' };
    const records = recordTelemetry();
    const svc = make();

    await expect(svc.authorize(makeContext('Bash'))).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('approval request was cancelled'),
    });

    expect(records).toContainEqual({
      event: 'permission_approval_result',
      properties: expect.objectContaining({
        policy_name: 'fallback-ask',
        tool_name: 'Bash',
        permission_mode: 'manual',
        result: 'cancelled',
        has_feedback: true,
        session_cache_written: false,
      }),
    });
  });

  it.each([
    ['rejected', { decision: 'rejected' }, 'rejected', false],
    ['cancelled', { decision: 'cancelled' }, 'cancelled', false],
    [
      'revise feedback',
      { decision: 'rejected', selectedLabel: 'Revise', feedback: 'Add verification.' },
      'rejected',
      true,
    ],
  ] as const)(
    'tracks plan review approval telemetry for %s',
    async (_name, response, expectedResult, expectedHasFeedback) => {
      mode = 'manual';
      policyResult = {
        policyName: 'exit-plan-mode-review-ask',
        result: {
          kind: 'ask',
          resolveApproval: () => ({
            kind: 'result',
            syntheticResult: { output: 'Plan review handled.' },
          }),
        },
      };
      approvalResponse = response;
      const records = recordTelemetry();
      const svc = make();

      await svc.authorize(makeContext('ExitPlanMode', {}, planReviewDisplay()));

      expect(records).toContainEqual({
        event: 'permission_approval_result',
        properties: expect.objectContaining({
          policy_name: 'exit-plan-mode-review-ask',
          tool_name: 'ExitPlanMode',
          permission_mode: 'manual',
          result: expectedResult,
          approval_surface: 'plan_review',
          duration_ms: expect.any(Number),
          session_cache_written: false,
          has_feedback: expectedHasFeedback,
        }),
      });
    },
  );

  it('tracks approval transport errors before rethrowing', async () => {
    policyResult = { policyName: 'exit-plan-mode-review-ask', result: { kind: 'ask' } };
    const error = new Error('approval transport closed');
    ix.set(ISessionApprovalService, {
      _serviceBrand: undefined,
      request: vi.fn(async () => {
        throw error;
      }),
      enqueue: (approval) => ({ ...approval, id: approval.id ?? 'approval-1' }),
      decide: () => {},
      listPending: () => [],
    });
    const records = recordTelemetry();
    const svc = make();

    await expect(svc.authorize(makeContext('ExitPlanMode'))).rejects.toThrow(
      'approval transport closed',
    );

    expect(records).toContainEqual({
      event: 'permission_approval_result',
      properties: expect.objectContaining({
        policy_name: 'exit-plan-mode-review-ask',
        tool_name: 'ExitPlanMode',
        result: 'error',
      }),
    });
  });

  it('merges the request trace id into approval result telemetry', async () => {
    mode = 'manual';
    policyResult = { policyName: 'p', result: { kind: 'ask' } };
    approvalResponse = { decision: 'approved' };
    const records = recordTelemetry();
    const svc = make();

    await svc.authorize(makeContext('bash', {}, undefined, 'trace-approval-1'));

    expect(records).toContainEqual({
      event: 'permission_approval_result',
      properties: expect.objectContaining({
        tool_name: 'bash',
        result: 'approved',
        trace_id: 'trace-approval-1',
      }),
    });
  });
});

interface MutableRulesOptions {
  readonly rules: () => readonly PermissionRule[];
  readonly sessionApprovalRulePatterns: () => readonly string[];
  readonly record?: (record: PermissionApprovalResultRecord) => void;
}

function mutablePermissionRulesService(
  options: MutableRulesOptions,
): IAgentPermissionRulesService {
  return {
    _serviceBrand: undefined,
    get rules() {
      return options.rules();
    },
    get sessionApprovalRulePatterns() {
      return options.sessionApprovalRulePatterns();
    },
    addRules: () => {},
    recordApprovalResult: (record) => options.record?.(record),
  };
}
