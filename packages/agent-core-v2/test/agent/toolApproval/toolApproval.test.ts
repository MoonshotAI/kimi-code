import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { UserCancellationError } from '#/_base/utils/abort';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  PermissionMode,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import {
  IAgentPermissionRulesService,
  type PermissionApprovalResultRecord,
} from '#/agent/permissionRules/permissionRules';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  IAgentToolApprovalService,
  type ToolApprovalRequestHookContext,
} from '#/agent/toolApproval/toolApproval';
import {
  AgentToolApprovalService,
  PermissionApprovalRequested,
  PermissionApprovalResolved,
} from '#/agent/toolApproval/toolApprovalService';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { Event2 } from '#/app/event/event2';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { OrderedHookSlot } from '#/hooks';
import type { ToolCall } from '#/kosong/contract/message';
import {
  ISessionApprovalService,
  type ApprovalRequest,
  type ApprovalResponse,
} from '#/session/approval/approval';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { stubPermissionModeService } from '../permissionMode/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

const RETRY_GUIDANCE =
  "Try a different approach — don't retry the same call, don't attempt to bypass the restriction.";

interface ContextOptions {
  readonly display?: ToolInputDisplay;
  readonly description?: string;
  readonly approvalRule?: string;
  readonly traceId?: string;
  readonly signal?: AbortSignal;
}

function makeContext(
  toolName: string,
  args: Record<string, unknown> = {},
  options: ContextOptions = {},
): ResolvedToolExecutionHookContext {
  const toolCall: ToolCall = {
    type: 'function',
    id: `call-${toolName}`,
    name: toolName,
    arguments: JSON.stringify(args),
  };
  return {
    turnId: 1,
    signal: options.signal ?? new AbortController().signal,
    trace: options.traceId === undefined ? undefined : { traceId: options.traceId },
    toolCall,
    toolCalls: [toolCall],
    args,
    execution: {
      description: options.description ?? `Approve ${toolName}`,
      display: options.display,
      approvalRule: options.approvalRule ?? toolName,
      execute: () => Promise.resolve({ output: '' }),
    },
  };
}

function ask(
  overrides: Partial<Extract<PermissionPolicyResult, { kind: 'ask' }>> = {},
): Extract<PermissionPolicyResult, { kind: 'ask' }> {
  return { kind: 'ask', ...overrides };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('AgentToolApprovalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let records: TelemetryRecord[];
  let recorded: PermissionApprovalResultRecord[];
  let eventBus: IEventBus;

  beforeEach(() => {
    disposables = new DisposableStore();
    eventBus = disposables.add(new EventBusService());
    mode = 'manual';
    records = [];
    recorded = [];
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: 'main' }),
        );
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.defineInstance(IAgentPermissionRulesService, {
          _serviceBrand: undefined,
          rules: [],
          sessionApprovalRulePatterns: [],
          addRules: () => {},
          recordApprovalResult: (record) => {
            recorded.push(record);
          },
        });
        reg.defineInstance(ISessionContext, makeSessionContext({
          sessionId: 'test-session',
          workspaceId: 'test-workspace',
          sessionDir: '/tmp/test-session',
          sessionScope: 'sessions/test-workspace/test-session',
          metaScope: 'sessions/test-workspace/test-session/session-meta',
          cwd: '/tmp/test-session',
        }));
        reg.defineInstance(ITelemetryService, recordingTelemetry(records));
        reg.defineInstance(IEventBus, eventBus);
        const dispatcher: IEventDispatcher = {
          _serviceBrand: undefined,
          hooks: { onDidRestore: new OrderedHookSlot() },
          dispatch: async (event: Event2) => {
            eventBus.publish(event);
          },
        } as unknown as IEventDispatcher;
        reg.defineInstance(IEventDispatcher, dispatcher);
        reg.define(IAgentToolApprovalService, AgentToolApprovalService);
      },
      strict: true,
    });
  });
  afterEach(() => {
    disposables.dispose();
  });

  function make(): IAgentToolApprovalService {
    return ix.get(IAgentToolApprovalService);
  }

  function useBroker(
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

  function subscribeApprovalEvents(): {
    readonly requested: ReturnType<typeof vi.fn>;
    readonly resolved: ReturnType<typeof vi.fn>;
  } {
    const requested = vi.fn();
    const resolved = vi.fn();
    disposables.add(eventBus.subscribe(PermissionApprovalRequested, requested));
    disposables.add(eventBus.subscribe(PermissionApprovalResolved, resolved));
    return { requested, resolved };
  }

  function useSubagentScope(): void {
    ix.set(
      IAgentScopeContext,
      makeAgentScopeContext({ agentId: 'sub-1', agentScope: 'sub-1' }),
    );
  }

  describe('resolvePermissionResolution', () => {
    it('maps an approve without metadata to undefined', async () => {
      const svc = make();
      await expect(
        svc.resolvePermissionResolution({ kind: 'approve' }, makeContext('Bash'), 'p'),
      ).resolves.toBeUndefined();
    });

    it('passes executionMetadata through on approve', async () => {
      const executionMetadata = { marker: true };
      const svc = make();
      await expect(
        svc.resolvePermissionResolution(
          { kind: 'approve', executionMetadata },
          makeContext('Bash'),
          'p',
        ),
      ).resolves.toEqual({ executionMetadata });
    });

    it('maps a deny to a block with the policy message', async () => {
      const svc = make();
      await expect(
        svc.resolvePermissionResolution(
          { kind: 'deny', message: 'nope' },
          makeContext('Bash'),
          'p',
        ),
      ).resolves.toEqual({ veto: { output: 'nope', isError: true } });
    });

    it('uses a default reason when a deny has no message', async () => {
      const svc = make();
      await expect(
        svc.resolvePermissionResolution({ kind: 'deny' }, makeContext('Bash'), 'p'),
      ).resolves.toEqual({
        veto: { output: 'Tool "Bash" was denied by permission policy.', isError: true },
      });
    });

    it('appends worker guidance to deny messages for subagents', async () => {
      useSubagentScope();
      const svc = make();
      await expect(
        svc.resolvePermissionResolution(
          { kind: 'deny', message: 'nope' },
          makeContext('Bash'),
          'p',
        ),
      ).resolves.toEqual({
        veto: { output: `nope ${RETRY_GUIDANCE}`, isError: true },
      });
    });

    it('strips the kind marker from result resolutions', async () => {
      const svc = make();
      await expect(
        svc.resolvePermissionResolution(
          {
            kind: 'result',
            result: { output: 'Plan review handled.' },
          },
          makeContext('ExitPlanMode'),
          'p',
        ),
      ).resolves.toEqual({
        veto: { output: 'Plan review handled.' },
      });
    });

    it('runs the ask round-trip for ask resolutions', async () => {
      useBroker(async () => ({ decision: 'approved' }));
      const svc = make();
      await expect(
        svc.resolvePermissionResolution(ask(), makeContext('Bash'), 'p'),
      ).resolves.toBeUndefined();
    });
  });

  describe('requestToolApproval', () => {
    it('auto-approves when no approval broker is registered', async () => {
      const events = subscribeApprovalEvents();
      const svc = make();

      await expect(
        svc.requestToolApproval(makeContext('Bash', { command: 'printf hi' }), ask(), 'fallback-ask'),
      ).resolves.toBeUndefined();

      expect(events.requested).not.toHaveBeenCalled();
      expect(events.resolved).not.toHaveBeenCalled();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        toolName: 'Bash',
        sessionApprovalRule: undefined,
        result: { decision: 'approved' },
      });
      expect(records).toContainEqual({
        event: 'permission_approval_result',
        properties: expect.objectContaining({
          policy_name: 'fallback-ask',
          tool_name: 'Bash',
          result: 'approved',
          session_cache_written: false,
          decision_source: 'implicit_no_broker',
        }),
      });
    });

    it('publishes approval events around the broker round-trip', async () => {
      const events = subscribeApprovalEvents();
      const request = useBroker(async () => ({
        decision: 'approved',
        selectedLabel: 'Approve once',
      }));
      const svc = make();

      await expect(
        svc.requestToolApproval(makeContext('Bash', { command: 'printf first' }), ask(), 'fallback-ask'),
      ).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledTimes(1);
      expect(events.requested).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'permission.approval.requested',
          id: expect.stringMatching(/^approval_/),
          permissionRequestId: expect.stringMatching(/^approval_/),
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
        }),
      );
      expect(events.resolved).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'permission.approval.resolved',
          id: expect.stringMatching(/^approval_/),
          permissionRequestId: expect.stringMatching(/^approval_/),
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
          decisionSource: 'native',
        }),
      );
    });

    it('uses the execution description and display when provided', async () => {
      const request = useBroker(async () => ({ decision: 'approved' }));
      const svc = make();
      const display: ToolInputDisplay = { kind: 'command', command: 'rm -rf build' };

      await svc.requestToolApproval(
        makeContext(
          'Bash',
          { command: 'rm -rf build' },
          { description: 'clean build output', display },
        ),
        ask(),
        'fallback-ask',
      );

      expect(request).toHaveBeenCalledWith({
        id: expect.stringMatching(/^approval_/),
        sessionId: 'test-session',
        agentId: 'main',
        turnId: 1,
        toolCallId: 'call-Bash',
        toolName: 'Bash',
        action: 'clean build output',
        display,
      });
    });

    it('mints one interaction id shared by the broker request and the events', async () => {
      const events = subscribeApprovalEvents();
      const request = useBroker(async () => ({ decision: 'approved' }));
      const svc = make();

      await svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask');

      const brokerId = request.mock.calls[0]![0].id;
      expect(brokerId).toMatch(/^approval_/);
      expect(events.requested.mock.calls[0]![0]).toMatchObject({ id: brokerId });
      expect(events.resolved.mock.calls[0]![0]).toMatchObject({ id: brokerId });
    });

    it('lets an approval participant decide without opening the native broker', async () => {
      const events = subscribeApprovalEvents();
      const request = useBroker(async () => ({ decision: 'approved' }));
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('test-external', async (ctx) => {
          ctx.response = { decision: 'approved' };
          ctx.decisionSource = 'external_hook';
        }),
      );

      await expect(
        svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask'),
      ).resolves.toBeUndefined();

      expect(request).not.toHaveBeenCalled();
      expect(events.resolved).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'approved',
          decisionSource: 'external_hook',
        }),
      );
      expect(records).toContainEqual({
        event: 'permission_approval_result',
        properties: expect.objectContaining({ decision_source: 'external_hook' }),
      });
    });

    it('propagates a pre-existing cancellation without starting participant work or the native broker', async () => {
      const controller = new AbortController();
      const cancellation = new UserCancellationError();
      controller.abort(cancellation);
      const request = useBroker(async () => ({ decision: 'approved' }));
      const participantWork = vi.fn();
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('test-external', async (ctx, next) => {
          ctx.signal.throwIfAborted();
          participantWork();
          await next();
        }),
      );

      await expect(
        svc.requestToolApproval(
          makeContext('Bash', {}, { signal: controller.signal }),
          ask(),
          'fallback-ask',
        ),
      ).rejects.toBe(cancellation);

      expect(participantWork).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(records).toEqual([]);
      expect(recorded).toEqual([]);
    });

    it('propagates cancellation while an approval participant is pending without falling back', async () => {
      const controller = new AbortController();
      const cancellation = new UserCancellationError();
      const request = useBroker(async () => ({ decision: 'approved' }));
      const participant = vi.fn(
        async (ctx: ToolApprovalRequestHookContext) =>
          new Promise<void>((resolve) => {
            ctx.signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          }),
      );
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('test-external', participant),
      );

      const promise = svc.requestToolApproval(
        makeContext('Bash', {}, { signal: controller.signal }),
        ask(),
        'fallback-ask',
      );
      const expectation = expect(promise).rejects.toBe(cancellation);
      await vi.waitFor(() => {
        expect(participant).toHaveBeenCalledTimes(1);
      });
      controller.abort(cancellation);
      await expectation;

      expect(request).not.toHaveBeenCalled();
      expect(records).toEqual([]);
      expect(recorded).toEqual([]);
    });

    it('uses the same approval participant path for subagent tool requests', async () => {
      useSubagentScope();
      const request = useBroker(async () => ({ decision: 'approved' }));
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('test-external', async (ctx) => {
          ctx.response = { decision: 'rejected', feedback: 'worker policy' };
          ctx.decisionSource = 'external_hook';
        }),
      );

      await expect(
        svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask'),
      ).resolves.toEqual({
        veto: {
          isError: true,
          output: expect.stringMatching(/external approval hook.*worker policy.*different approach/),
        },
      });
      expect(request).not.toHaveBeenCalled();
    });

    it('falls back to the native broker when a participant returns no decision', async () => {
      const request = useBroker(async () => ({ decision: 'approved' }));
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('empty-participant', async () => {}),
      );

      await expect(
        svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask'),
      ).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledTimes(1);
    });

    it('falls back to the native broker exactly once when a participant throws', async () => {
      const request = useBroker(async () => ({ decision: 'approved' }));
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('throwing-participant', async () => {
          throw new Error('participant failed');
        }),
      );

      await expect(
        svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask'),
      ).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not retry the native broker when it throws inside the participant chain', async () => {
      const brokerError = new Error('approval transport closed');
      const request = useBroker(async () => {
        throw brokerError;
      });
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('passthrough-participant', async (_ctx, next) => {
          await next();
        }),
      );

      await expect(
        svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask'),
      ).rejects.toBe(brokerError);

      expect(request).toHaveBeenCalledTimes(1);
    });

    it('opens the native broker once when a participant calls next sequentially', async () => {
      const events = subscribeApprovalEvents();
      const request = useBroker(async () => ({ decision: 'approved' }));
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('repeating-participant', async (_ctx, next) => {
          await next();
          await next();
        }),
      );

      await expect(
        svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask'),
      ).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledTimes(1);
      expect(events.resolved).toHaveBeenCalledTimes(1);
      expect(recorded).toHaveLength(1);
    });

    it('opens the native broker once when a participant calls next concurrently', async () => {
      const events = subscribeApprovalEvents();
      const request = useBroker(async () => ({ decision: 'approved' }));
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('concurrent-participant', async (_ctx, next) => {
          await Promise.all([next(), next()]);
        }),
      );

      await expect(
        svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask'),
      ).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledTimes(1);
      expect(events.resolved).toHaveBeenCalledTimes(1);
      expect(recorded).toHaveLength(1);
    });

    it('reuses a deferred native broker when a participant returns without awaiting next', async () => {
      const events = subscribeApprovalEvents();
      const broker = deferred<ApprovalResponse>();
      const request = useBroker(() => broker.promise);
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('detached-participant', (_ctx, next) => {
          void next();
        }),
      );

      const approval = svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask');
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledTimes(1);
      });
      expect(events.resolved).not.toHaveBeenCalled();
      broker.resolve({ decision: 'approved' });

      await expect(approval).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledTimes(1);
      expect(events.resolved).toHaveBeenCalledTimes(1);
      expect(recorded).toHaveLength(1);
    });

    it('reports a detached native broker rejection once without an unhandled branch', async () => {
      const brokerError = new Error('approval transport closed');
      const broker = deferred<ApprovalResponse>();
      const request = useBroker(() => broker.promise);
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('detached-participant', (_ctx, next) => {
          void next();
        }),
      );

      const approval = svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask');
      const expectation = expect(approval).rejects.toBe(brokerError);
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledTimes(1);
      });
      broker.reject(brokerError);
      await expectation;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(request).toHaveBeenCalledTimes(1);
      expect(recorded).toHaveLength(0);
    });

    it('preserves the broker error when a participant throws after awaiting next', async () => {
      const brokerError = new Error('approval transport closed');
      const participantError = new Error('participant failed after next');
      const broker = deferred<ApprovalResponse>();
      const request = useBroker(() => broker.promise);
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('throwing-participant', async (_ctx, next) => {
          await next();
          throw participantError;
        }),
      );

      const approval = svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask');
      const expectation = expect(approval).rejects.toBe(brokerError);
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledTimes(1);
      });
      broker.reject(brokerError);
      await expectation;

      expect(request).toHaveBeenCalledTimes(1);
      expect(recorded).toHaveLength(0);
    });

    it('uses the broker result when a participant throws after starting detached next', async () => {
      const broker = deferred<ApprovalResponse>();
      const request = useBroker(() => broker.promise);
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('throwing-participant', (_ctx, next) => {
          void next();
          throw new Error('participant failed after detached next');
        }),
      );

      const approval = svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask');
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledTimes(1);
      });
      broker.resolve({ decision: 'approved' });

      await expect(approval).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledTimes(1);
      expect(recorded).toHaveLength(1);
    });

    it('keeps the root approval alive when a detached fork signal is cancelled', async () => {
      const rootController = new AbortController();
      const forkController = new AbortController();
      const broker = deferred<ApprovalResponse>();
      const request = useBroker(() => broker.promise);
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('forking-participant', (ctx, next) => {
          void next({ ...ctx, signal: forkController.signal });
        }),
      );

      const approval = svc.requestToolApproval(
        makeContext('Bash', {}, { signal: rootController.signal }),
        ask(),
        'fallback-ask',
      );
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledTimes(1);
      });
      forkController.abort(new UserCancellationError());
      broker.resolve({ decision: 'approved' });

      await expect(approval).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledTimes(1);
      expect(recorded).toHaveLength(1);
    });

    it('cancels the root approval while a detached fork keeps waiting on the broker', async () => {
      const rootController = new AbortController();
      const forkController = new AbortController();
      const cancellation = new UserCancellationError();
      const broker = deferred<ApprovalResponse>();
      const request = useBroker(() => broker.promise);
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('forking-participant', (ctx, next) => {
          void next({ ...ctx, signal: forkController.signal });
        }),
      );

      const approval = svc.requestToolApproval(
        makeContext('Bash', {}, { signal: rootController.signal }),
        ask(),
        'fallback-ask',
      );
      const expectation = expect(approval).rejects.toBe(cancellation);
      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledTimes(1);
      });
      rootController.abort(cancellation);
      await expectation;
      broker.resolve({ decision: 'approved' });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(request).toHaveBeenCalledTimes(1);
      expect(recorded).toHaveLength(0);
    });

    it('does not invoke approval participants for custom continuations', async () => {
      const request = useBroker(async () => ({ decision: 'approved' }));
      const participant = vi.fn();
      const svc = make();
      disposables.add(
        svc.hooks.onWillRequestApproval.register('external', participant),
      );

      await svc.requestToolApproval(
        makeContext('ExitPlanMode'),
        ask({ resolveApproval: () => ({ kind: 'result', result: { output: 'done' } }) }),
        'exit-plan-mode-review-ask',
      );

      expect(participant).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('records a session-scope approval rule when approved for session', async () => {
      useBroker(async () => ({
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      }));
      const svc = make();

      await expect(
        svc.requestToolApproval(makeContext('Custom', { query: 'first' }), ask(), 'fallback-ask'),
      ).resolves.toBeUndefined();

      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        turnId: 1,
        toolCallId: 'call-Custom',
        toolName: 'Custom',
        action: 'Approve Custom',
        sessionApprovalRule: 'Custom',
        result: { decision: 'approved', scope: 'session' },
      });
      expect(records).toContainEqual({
        event: 'permission_approval_result',
        properties: expect.objectContaining({
          tool_name: 'Custom',
          result: 'approved_for_session',
          session_cache_written: true,
        }),
      });
    });

    it('keeps approved-once responses out of the session cache', async () => {
      useBroker(async () => ({ decision: 'approved' }));
      const svc = make();

      await svc.requestToolApproval(makeContext('Custom'), ask(), 'fallback-ask');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        sessionApprovalRule: undefined,
        result: { decision: 'approved' },
      });
      expect(records).toContainEqual({
        event: 'permission_approval_result',
        properties: expect.objectContaining({
          result: 'approved',
          session_cache_written: false,
        }),
      });
    });

    it('maps a rejected response to a block', async () => {
      useBroker(async () => ({ decision: 'rejected' }));
      const svc = make();

      await expect(
        svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask'),
      ).resolves.toEqual({
        veto: {
          output: 'Tool "Bash" was not run because the user rejected the approval request.',
          isError: true,
        },
      });
    });

    it('appends worker guidance to rejection messages for subagents', async () => {
      useSubagentScope();
      useBroker(async () => ({ decision: 'rejected', feedback: 'too broad' }));
      const svc = make();

      await expect(
        svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask'),
      ).resolves.toEqual({
        veto: {
          output:
            'Tool "Bash" was not run because the user rejected the approval request.' +
            ` Reason: too broad ${RETRY_GUIDANCE}`,
          isError: true,
        },
      });
    });

    it('tracks cancelled approval requests', async () => {
      useBroker(async () => ({ decision: 'cancelled', feedback: 'request closed' }));
      const svc = make();

      await expect(
        svc.requestToolApproval(makeContext('Bash'), ask(), 'fallback-ask'),
      ).resolves.toMatchObject({
        veto: {
          output: expect.stringContaining('approval request was cancelled'),
          isError: true,
        },
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
      'tracks ask continuation telemetry for %s',
      async (_name, response, expectedResult, expectedHasFeedback) => {
        useBroker(async () => response);
        const svc = make();
        const display: ToolInputDisplay = {
          kind: 'plan_review',
          plan: '# Plan',
          path: '/tmp/kimi-plan.md',
        };

        await expect(
          svc.requestToolApproval(
            makeContext('ExitPlanMode', {}, { display }),
            ask({
              resolveApproval: () => ({
                kind: 'result',
                result: { output: 'Plan review handled.' },
              }),
            }),
            'exit-plan-mode-review-ask',
          ),
        ).resolves.toEqual({
          veto: { output: 'Plan review handled.' },
        });

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
      const events = subscribeApprovalEvents();
      const error = new Error('approval transport closed');
      useBroker(async () => {
        throw error;
      });
      const svc = make();

      await expect(
        svc.requestToolApproval(makeContext('ExitPlanMode'), ask(), 'exit-plan-mode-review-ask'),
      ).rejects.toThrow('approval transport closed');

      expect(records).toContainEqual({
        event: 'permission_approval_result',
        properties: expect.objectContaining({
          policy_name: 'exit-plan-mode-review-ask',
          tool_name: 'ExitPlanMode',
          result: 'error',
        }),
      });
      expect(events.resolved).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'permission.approval.resolved',
          decision: 'error',
          error: 'approval transport closed',
        }),
      );
    });

    it('folds resolveError continuations into the result instead of rethrowing', async () => {
      useBroker(async () => {
        throw new Error('approval transport closed');
      });
      const svc = make();

      await expect(
        svc.requestToolApproval(
          makeContext('ExitPlanMode'),
          ask({ resolveError: () => ({ kind: 'deny', message: 'review unavailable' }) }),
          'exit-plan-mode-review-ask',
        ),
      ).resolves.toEqual({
        veto: { output: 'review unavailable', isError: true },
      });
    });

    it('rethrows user cancellations without telemetry or resolution events', async () => {
      const events = subscribeApprovalEvents();
      const controller = new AbortController();
      useBroker(() => new Promise<ApprovalResponse>(() => {}));
      const svc = make();

      const promise = svc.requestToolApproval(
        makeContext('Bash', {}, { signal: controller.signal }),
        ask(),
        'fallback-ask',
      );
      const expectation = expect(promise).rejects.toBeInstanceOf(UserCancellationError);
      controller.abort(new UserCancellationError());
      await expectation;

      expect(events.requested).toHaveBeenCalledTimes(1);
      expect(events.resolved).not.toHaveBeenCalled();
      expect(records).toEqual([]);
      expect(recorded).toEqual([]);
    });

    it('merges the request trace id into approval result telemetry', async () => {
      useBroker(async () => ({ decision: 'approved' }));
      const svc = make();

      await svc.requestToolApproval(
        makeContext('bash', {}, { traceId: 'trace-approval-1' }),
        ask(),
        'fallback-ask',
      );

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

  describe('message formatting', () => {
    it('keeps deny messages plain for the main agent', () => {
      const svc = make();
      expect(svc.formatDenyMessage('nope')).toBe('nope');
    });

    it('appends worker guidance to deny messages for subagents', () => {
      useSubagentScope();
      const svc = make();
      expect(svc.formatDenyMessage('nope')).toBe(`nope ${RETRY_GUIDANCE}`);
    });

    it('includes feedback in rejection messages', () => {
      const svc = make();
      expect(
        svc.formatApprovalRejectionMessage('Bash', {
          decision: 'rejected',
          feedback: 'too broad',
        }),
      ).toBe(
        'Tool "Bash" was not run because the user rejected the approval request. Reason: too broad',
      );
    });

    it('uses the cancelled prefix for cancellations', () => {
      const svc = make();
      expect(svc.formatApprovalRejectionMessage('Bash', { decision: 'cancelled' })).toBe(
        'Tool "Bash" was not run because the approval request was cancelled.',
      );
    });

    it('attributes external hook rejections accurately', () => {
      const svc = make();
      expect(
        svc.formatApprovalRejectionMessage(
          'Bash',
          { decision: 'rejected', feedback: 'too broad' },
          'external_hook',
        ),
      ).toBe(
        'Tool "Bash" was not run because an external approval hook rejected the approval request. Reason: too broad',
      );
    });
  });
});
