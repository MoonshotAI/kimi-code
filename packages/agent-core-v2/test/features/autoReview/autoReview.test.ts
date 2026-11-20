import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#/session/subagent/runAgentTurn', () => ({
  runAgentTurn: vi.fn(),
}));

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { OrderedHookSlot } from '#/hooks';
import {
  IAgentLoopService,
  type AfterStepContext,
  type BeforeStepContext,
  type PromptSubmitContext,
} from '#/agent/loop/loop';
import { userPromptSubmitHookPart } from '#/agent/contextMemory/hookParts';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentPermissionGate, type PermissionGateReviewer } from '#/agent/permissionGate/permissionGate';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentProfileService, type ProfileUpdateData } from '#/agent/profile/profile';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { BeforeToolExecuteEventImpl } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { BeforeToolExecuteEvent } from '#/agent/toolExecutor/toolHooks';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IGitService, type FsGitStatusResponse, type GitStatusOptions } from '#/app/git/git';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import REVIEW_POLICY from '../../../src/features/autoReview/auto-review-policy.md?raw';
import { AutoReviewCompleted, AutoReviewStarted } from '#/features/autoReview/autoReviewEvents';
import { autoReviewTrigger } from '#/features/autoReview/autoReviewGate';
import { AUTO_REVIEW_SECTION } from '#/features/autoReview/configSection';
import { AUTO_REVIEW_CIRCUIT_BREAKER_STOP_REASON, type AutoReviewResult } from '#/features/autoReview/review';
import { AutoReviewService, parseReviewJson } from '#/features/autoReview/reviewService';
import { APIContextOverflowError, APIProviderRateLimitError } from '#/llm-adapter/contract/errors';
import type { ToolCall } from '@moonshot-ai/core/llm/message';
import { emptyUsage } from '@moonshot-ai/core/llm/usage';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { CreateAgentOptions } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { isSubagentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { SECONDARY_MODEL_SECTION, type SecondaryModelConfig } from '#/session/subagent/configSection';
import type { AgentRunCompletion, AgentRunHandle, AgentRunRequest, RunAgentOptions } from '#/session/subagent/subagent';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ExecutableTool } from '#/tool/toolContract';

import { stubFlag } from '../../app/flag/stubs';
import { stubLog } from '../../_base/log/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubPermissionModeService } from '../../agent/permissionMode/stubs';
import { stubWorkspaceContext } from '../../session/workspaceContext/stub-workspace-context';

const ALLOW = '{"authorization":"explicit","risk":"low","decision":"allow","reason":null}';
const DENY = '{"authorization":"none","risk":"medium","decision":"deny","reason":"Needs confirmation."}';
const defaultSignal = new AbortController().signal;

describe('AutoReviewService', () => {
  interface ReviewerRun {
    readonly options: CreateAgentOptions;
    readonly prompt: string;
    readonly mode: string;
  }

  let disposables: DisposableStore;
  let runs: ReviewerRun[];
  let summary: string;
  let runError: Error | undefined;
  let history: ContextMessage[];
  let mainHistory: ContextMessage[] | undefined;
  let agentId: string;
  let agentLabels: Readonly<Record<string, string>> | undefined;
  let activeMode: PermissionMode;
  let agentsMd: string;
  let telemetry: TelemetryRecord[];
  let reviewEvents: AutoReviewCompleted[];
  let reviewStarts: AutoReviewStarted[];
  let usage: Parameters<ISessionUsageService['record']>[];
  let compactions: Array<{ readonly source: string }>;
  let registeredReviewer: PermissionGateReviewer | undefined;
  let reviewerGateReviewer: PermissionGateReviewer | undefined;
  let reviewerLegacyStarting: Array<(event: BeforeToolExecuteEvent) => void>;
  let reviewerUpdates: ProfileUpdateData[];
  let reviewerBeforeStepHooks: OrderedHookSlot<BeforeStepContext>;
  let afterStepHooks: OrderedHookSlot<AfterStepContext>;
  let removed: string[];
  let modes: string[];
  let gitStatusImpl: ((cwd: string, options?: GitStatusOptions) => Promise<FsGitStatusResponse>) | undefined;
  let releaseRun: () => void;
  let holdRuns: boolean;
  let held: Array<() => void>;

  beforeEach(() => {
    disposables = new DisposableStore();
    runs = [];
    removed = [];
    modes = [];
    reviewEvents = [];
    reviewStarts = [];
    usage = [];
    compactions = [];
    registeredReviewer = undefined;
    reviewerGateReviewer = undefined;
    reviewerLegacyStarting = [];
    reviewerUpdates = [];
    reviewerBeforeStepHooks = new OrderedHookSlot<BeforeStepContext>();
    afterStepHooks = new OrderedHookSlot<AfterStepContext>();
    gitStatusImpl = undefined;
    mainHistory = undefined;
    agentId = 'main';
    agentLabels = undefined;
    activeMode = 'yolo';
    summary = ALLOW;
    runError = undefined;
    holdRuns = false;
    held = [];
    releaseRun = () => {
      const waiting = held.splice(0);
      for (const finish of waiting) finish();
    };
    history = [
      { role: 'user', content: [{ type: 'text', text: 'Only remove generated files.' }], origin: { kind: 'user' } },
      { role: 'assistant', content: [], toolCalls: [toolCallFor('mkdir', 'Bash', { command: 'mkdir generated' })] },
      { role: 'tool', toolCallId: 'mkdir', content: [{ type: 'text', text: 'created generated/' }] },
    ];
    agentsMd = 'Do not delete user-data.';
    telemetry = [];
  });

  afterEach(() => {
    releaseRun();
    disposables.dispose();
  });

  function service(
    model?: string,
    configured = true,
    secondaryModel?: SecondaryModelConfig,
    timeoutMs = 30000,
  ): AutoReviewService {
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IConfigService, {
          get: ((section: string) => {
            if (section === AUTO_REVIEW_SECTION && configured) return { model, timeoutMs };
            if (section === SECONDARY_MODEL_SECTION) return secondaryModel;
            return undefined;
          }) as IConfigService['get'],
        });
        reg.defineInstance(IFlagService, stubFlag(true));
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => activeMode));
        reg.definePartialInstance(IAgentPermissionGate, {
          registerReviewer: (reviewer) => {
            registeredReviewer = reviewer;
            return { dispose: () => {} };
          },
        });
        reg.definePartialInstance(IAgentEnvironmentBindingService, {
          current: { environmentId: 'local', cwd: '/workspace' },
        });
        reg.definePartialInstance(ISessionUsageService, {
          record: async (...args) => {
            usage.push(args);
          },
        });
        reg.definePartialInstance(IAgentProfileService, {
          resolveModelContext: () => ({ modelAlias: 'main-model' }) as ReturnType<IAgentProfileService['resolveModelContext']>,
        });
        reg.definePartialInstance(IAgentLoopService, {
          history: () => history,
          hooks: {
            onWillBeginStep: new OrderedHookSlot<BeforeStepContext>(),
            onDidFinishStep: afterStepHooks,
            onBeforeSubmitPrompt: new OrderedHookSlot<PromptSubmitContext>(),
          },
        });
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({
            agentId,
            agentScope: '',
            meta: agentLabels === undefined ? undefined : { labels: agentLabels },
          }),
        );
        reg.definePartialInstance(IAgentLifecycleService, {
          create: async (options) => {
            runs.push({ options: options ?? {}, prompt: '', mode: '' });
            return { agentId: `reviewer-${runs.length}` } as AgentContext;
          },
          handleOf: (id) => {
            if (id === 'main' && mainHistory !== undefined) {
              return {
                id: 'main',
                kind: 'agent',
                accessor: { get: () => ({ history: () => mainHistory ?? [] }) },
                dispose: () => {},
              } as unknown as ReturnType<IAgentLifecycleService['handleOf']>;
            }
            if (id !== 'main' && !id.startsWith('reviewer-')) return undefined;
            return {
              id,
              kind: 'agent',
              accessor: {
                get: (token: unknown) => {
                  if (token === IAgentPermissionModeService) {
                    return { setMode: (mode: string) => { modes.push(mode); } };
                  }
                  if (token === IAgentToolExecutorService) {
                    return {
                      registerLegacyStarting: (fn: (event: BeforeToolExecuteEvent) => void) => {
                        reviewerLegacyStarting.push(fn);
                        return { dispose: () => {} };
                      },
                    };
                  }
                  if (token === IAgentPermissionGate) {
                    return {
                      registerReviewer: (reviewer: PermissionGateReviewer) => {
                        reviewerGateReviewer = reviewer;
                        return { dispose: () => {} };
                      },
                    };
                  }
                  if (token === IAgentLoopService) {
                    return {
                      history: () => (id === 'main' ? mainHistory ?? [] : history),
                      hooks: {
                        onWillBeginStep: reviewerBeforeStepHooks,
                        onDidFinishStep: new OrderedHookSlot<AfterStepContext>(),
                      },
                      update: (changed: ProfileUpdateData) => {
                        reviewerUpdates.push(changed);
                      },
                    };
                  }
                  return undefined;
                },
              },
              dispose: () => {},
            } as unknown as ReturnType<IAgentLifecycleService['handleOf']>;
          },
          remove: async (agent) => {
            removed.push(agent.agentId);
          },
        });
        reg.definePartialInstance(IEventDispatcher, {
          dispatch: async (event) => {
            if (event instanceof AutoReviewCompleted) reviewEvents.push(event);
            if (event instanceof AutoReviewStarted) reviewStarts.push(event);
          },
        });
        reg.definePartialInstance(ISessionInstructionsProvider, {
          ready: Promise.resolve(),
          get agentsMd() { return agentsMd; },
          agentsMdPaths: ['/workspace/AGENTS.md'],
        });
        reg.defineInstance(ISessionWorkspaceContext, stubWorkspaceContext('/workspace'));
        reg.defineInstance(ITelemetryService, recordingTelemetry(telemetry));
        reg.defineInstance(ILogService, stubLog());
        reg.definePartialInstance(IAgentFullCompactionService, {
          begin: (input) => {
            compactions.push(input);
            return true;
          },
        });
        if (gitStatusImpl !== undefined) {
          reg.definePartialInstance(IGitService, {
            status: (cwd, options) => gitStatusImpl!(cwd, options),
          });
        }
      },
      strict: true,
    });
    vi.mocked(runAgentTurn).mockImplementation(
      async (_handle, request: AgentRunRequest, options: RunAgentOptions): Promise<AgentRunHandle> => {
        const current = runs.at(-1);
        if (current !== undefined && request.kind === 'prompt') {
          runs[runs.length - 1] = { ...current, prompt: request.prompt, mode: modes.at(-1) ?? '' };
        }
        if (holdRuns) {
          await new Promise<void>((resolve, reject) => {
            held.push(resolve);
            options.signal.addEventListener('abort', () => {
              const reason = options.signal.reason;
              reject(reason instanceof Error ? reason : new Error('The review was aborted.'));
            }, { once: true });
          });
        }
        options.signal.throwIfAborted();
        if (runError !== undefined) throw runError;
        const completion: AgentRunCompletion = { summary, usage: emptyUsage() };
        return {
          agentId: 'reviewer',
          completion: Promise.resolve(completion),
          partialOutput: () => summary,
        };
      },
    );
    return ix.createInstance(new SyncDescriptor(AutoReviewService));
  }

  const bashTool: ExecutableTool = {
    name: 'Bash',
    description: 'Execute a shell command.',
    parameters: { type: 'object' },
    resolveExecution: () => ({ output: '', isError: true }),
  };

  function review(
    reviewer = service(),
    command = 'rm generated/file',
    turnId = 0,
  ): Promise<AutoReviewResult> {
    return reviewer.review(
      reviewContext({ toolName: 'Bash', args: { command }, tool: bashTool, turnId }),
      'fallback-ask',
    );
  }

  function sentContent(index = -1): string {
    return runs.at(index)?.prompt ?? '';
  }

  it('spawns a dedicated read-only reviewer profile without subagent parent metadata', async () => {
    await expect(review(service(undefined, false))).resolves.toEqual({
      kind: 'decision',
      decision: { authorization: 'explicit', risk: 'low', decision: 'allow' },
    });
    expect(runs[0]?.options.binding).toBeUndefined();
    expect(runs[0]?.options.initialProfile).toEqual({
      modelAlias: 'main-model',
      profileName: 'auto-review',
      thinkingLevel: 'off',
      systemPrompt: REVIEW_POLICY,
      activeToolNames: ['Read', 'Grep', 'Glob'],
      disallowedTools: ['select_tools'],
    });
    expect(runs[0]?.options.labels).toEqual({
      autoReview: 'reviewer',
      reviewerForAgentId: 'main',
    });
    expect(isSubagentMeta({ labels: runs[0]?.options.labels })).toBe(false);
    expect(runs[0]?.mode).toBe('manual');
    expect(removed).toEqual(['reviewer-1']);
  });

  it('skips recursive reviewer registration inside a reviewer agent scope', () => {
    agentLabels = { autoReview: 'reviewer', reviewerForAgentId: 'main' };
    service();
    expect(registeredReviewer).toBeUndefined();
  });

  it('vetoes non-readonly tools, denies asks without user prompts, and caps tool steps on the reviewer', async () => {
    let capturedReviewerGate: PermissionGateReviewer | undefined;
    let capturedStarting: ((event: BeforeToolExecuteEvent) => void) | undefined;
    const reviewer = service();
    vi.mocked(runAgentTurn).mockImplementation(async (_handle, request) => {
      capturedReviewerGate = reviewerGateReviewer;
      capturedStarting = reviewerLegacyStarting.at(-1);
      await reviewerBeforeStepHooks.run({
        turnId: 0,
        step: 2,
        firstStepOfTurn: false,
        signal: defaultSignal,
      });
      expect(reviewerUpdates).toEqual([]);
      await reviewerBeforeStepHooks.run({
        turnId: 0,
        step: 3,
        firstStepOfTurn: false,
        signal: defaultSignal,
      });
      expect(reviewerUpdates).toEqual([{ activeToolNames: [] }]);
      if (request.kind === 'prompt') {
        runs[runs.length - 1] = { ...runs.at(-1)!, prompt: request.prompt, mode: modes.at(-1) ?? '' };
      }
      return {
        agentId: 'reviewer',
        completion: Promise.resolve({ summary: ALLOW, usage: emptyUsage() }),
        partialOutput: () => ALLOW,
      };
    });

    await review(reviewer);

    const bashEvent = new BeforeToolExecuteEventImpl(reviewContext({ toolName: 'Bash', args: { command: 'git status' } }));
    capturedStarting?.(bashEvent);
    expect(bashEvent.vetoResult).toMatchObject({ isError: true });

    const readEvent = new BeforeToolExecuteEventImpl(reviewContext({ toolName: 'Read', args: { file_path: 'a.ts' } }));
    capturedStarting?.(readEvent);
    expect(readEvent.vetoResult).toBeUndefined();

    const askReview = capturedReviewerGate?.review(readEvent, {
      policyName: 'sensitive-file-access-ask',
      result: { kind: 'ask' },
    });
    await expect(askReview?.()).resolves.toMatchObject({
      policyName: 'auto-review-reviewer-readonly',
      result: { kind: 'deny' },
    });
  });

  it('sends chronological transcript with recent untrusted tool outputs and omits policy from user prompt', async () => {
    expect(await review()).toEqual({
      kind: 'decision',
      decision: { authorization: 'explicit', risk: 'low', decision: 'allow' },
    });
    expect(sentContent()).not.toContain('Review only the pending tool call.');
    expect(sentContent()).toContain('human-instruction');
    expect(sentContent()).toContain('Do not delete user-data.');
    expect(sentContent()).toContain('untrusted-tool-output');
    expect(sentContent()).toContain('created generated/');
    expect(sentContent()).toContain('rm generated/file');
  });

  it('marks user-approved calls and omits tool metadata', async () => {
    const reviewer = service();
    summary = DENY;
    const firstContext = reviewContext({ id: 'mkdir', toolName: 'Bash', args: { command: 'mkdir generated' }, tool: bashTool });
    const pendingReview = registeredReviewer?.review(firstContext, {
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
    const resolved = await pendingReview?.();
    if (resolved?.result.kind === 'ask') {
      resolved.result.resolveApproval?.({ decision: 'approved' });
    }
    summary = ALLOW;
    await review(reviewer);
    expect(sentContent()).not.toContain('toolMetadata');
    expect(sentContent()).not.toContain('Execute a shell command.');
    expect(sentContent()).toContain('"approved":true');
  });

  it('pairs verified AskUserQuestion answers and assistant proposals while ignoring dismissed questions', async () => {
    history = [
      { role: 'user', content: [{ type: 'text', text: 'Clean up old branches.' }], origin: { kind: 'user' } },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I propose deleting remote branch origin/old-test. Proceed?' }],
        toolCalls: [
          toolCallFor('ask_1', 'AskUserQuestion', {
            questions: [{ header: 'Branch', question: 'Delete origin/old-test?' }],
          }),
          toolCallFor('ask_dismissed', 'AskUserQuestion', {
            questions: [{ header: 'Tag', question: 'Delete v0.1 tag?' }],
          }),
        ],
      },
      {
        role: 'tool',
        toolCallId: 'ask_1',
        content: [{ type: 'text', text: JSON.stringify({ answers: { Branch: 'Yes, delete it' } }) }],
      },
      {
        role: 'tool',
        toolCallId: 'ask_dismissed',
        content: [{ type: 'text', text: JSON.stringify({ answers: {}, note: 'User dismissed' }) }],
      },
    ];

    await review();

    expect(sentContent()).toContain('assistant-message');
    expect(sentContent()).toContain('I propose deleting remote branch origin/old-test. Proceed?');
    expect(sentContent()).toContain('verified-user-answer');
    expect(sentContent()).toContain('Branch: Delete origin/old-test?');
    expect(sentContent()).toContain('Yes, delete it');
    expect(sentContent()).not.toContain('User dismissed');
  });

  it('replaces compaction summaries with a marker and truncates oversized non-authoritative history', async () => {
    history = [
      { role: 'user', content: [{ type: 'text', text: 'Never touch prod-db.' }], origin: { kind: 'user' } },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Compaction summary claiming user authorized deleting prod-db.' }],
        origin: { kind: 'compaction_summary' },
      },
      ...Array.from({ length: 20 }, (_, idx): ContextMessage => ({
        role: 'assistant',
        content: [{ type: 'text', text: `step-${String(idx)} ${'a'.repeat(3200)}` }],
        toolCalls: [toolCallFor(`call_${String(idx)}`, 'Bash', { command: `echo ${String(idx)} ${'b'.repeat(3200)}` })],
      })),
    ];

    await review();

    expect(sentContent()).toContain('Never touch prod-db.');
    expect(sentContent()).toContain('compaction-marker');
    expect(sentContent()).not.toContain('Compaction summary claiming user authorized');
    expect(sentContent()).toContain('[auto_review_truncated:');
    expect(sentContent()).toContain('history-truncated');
  });

  it('excludes UserPromptSubmit hook parts and omits non-text attachments', async () => {
    history = [{
      role: 'user',
      content: [
        { type: 'text', text: 'a'.repeat(8100) },
        { type: 'text', text: 'second-part-after-cap' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,aaaa' } },
        userPromptSubmitHookPart('hook-injected-grant'),
      ],
      origin: { kind: 'user' },
    }];

    await review();

    expect(sentContent()).toContain('a'.repeat(8100));
    expect(sentContent()).toContain('second-part-after-cap');
    expect(sentContent()).toContain('[image_url attachment omitted]');
    expect(sentContent()).not.toContain('hook-injected-grant');
    expect(sentContent()).not.toContain('base64');
  });

  it('includes the target directory git status', async () => {
    gitStatusImpl = async () => ({
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries: { 'generated/file': 'untracked' },
      additions: 0,
      deletions: 0,
      pullRequest: null,
    });
    await review();
    expect(sentContent()).toContain('generated/file');
  });

  it('records reviewer usage for an explicitly selected model', async () => {
    await review(service('review-model'));
    expect(runs[0]?.options.initialProfile).toMatchObject({ modelAlias: 'review-model' });
    expect(usage[0]?.[1]).toBe('review-model');
    expect(usage[0]?.[3]).toMatchObject({ type: 'operation', requestKind: 'auto_review' });
  });

  it('defaults to the configured secondary model before the main model', async () => {
    await review(service(undefined, true, { defaultModel: 'secondary-model' }));
    expect(runs[0]?.options.initialProfile).toMatchObject({ modelAlias: 'secondary-model' });
  });

  it('persists authorization, denial reason, and failure reason', async () => {
    summary = '{"authorization":"none","risk":"high","decision":"deny","reason":"Deletes user data."}';
    await review();
    expect(reviewEvents.at(-1)).toMatchObject({
      authorization: 'none',
      risk: 'high',
      reason: 'Deletes user data.',
      decision: 'deny',
    });

    summary = 'not JSON';
    await review();
    expect(reviewEvents.at(-1)?.decision).toBe('failed');
  });

  it('parses fenced or prose-prefixed JSON and enforces authorization-risk invariants', async () => {
    for (const line of REVIEW_POLICY.split('\n').filter((entry) => entry.startsWith('{'))) {
      summary = line;
      await expect(review()).resolves.toMatchObject({ kind: 'decision' });
    }

    summary = 'Checked `${DIR}` safely.\n```json\n{"authorization":"explicit","risk":"medium","decision":"allow","reason":null}\n```';
    await expect(review()).resolves.toEqual({
      kind: 'decision',
      decision: { authorization: 'explicit', risk: 'medium', decision: 'allow' },
    });
    expect(parseReviewJson('prefix {not json} {"decision":"allow"}')).toEqual({ decision: 'allow' });

    for (const invalid of [
      'not JSON',
      '{"authorization":"ambiguous","risk":"medium","decision":"allow","reason":null}',
      '{"authorization":"none","risk":"medium","decision":"allow","reason":null}',
      '{"authorization":"explicit","risk":"high","decision":"allow","reason":null}',
      '{"authorization":"none","risk":"low","decision":"deny","reason":"no"}',
      '{"risk":"low","decision":"allow","reason":null}',
    ]) {
      runs = [];
      summary = invalid;
      await expect(review()).resolves.toMatchObject({ kind: 'failed' });
      expect(runs).toHaveLength(3);
    }
  });

  it('trips the circuit breaker after 3 consecutive Never Ask denials and stops the turn', async () => {
    activeMode = 'auto';
    summary = DENY;
    const reviewer = service();

    const outcomes: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      const ctx = reviewContext({ id: `deny_${String(i)}`, toolName: 'Bash', args: { command: 'rm -rf /tmp/x' }, turnId: 4 });
      const pending = registeredReviewer?.review(ctx, { policyName: 'fallback-ask', result: { kind: 'ask' } });
      const resolved = await pending?.();
      outcomes.push(resolved?.result);
    }

    expect(outcomes[0]).toMatchObject({ kind: 'deny', reason: { review_risk: 'medium' } });
    expect(outcomes[1]).toMatchObject({ kind: 'deny', reason: { review_risk: 'medium' } });
    expect(outcomes[2]).toMatchObject({
      kind: 'deny',
      message: expect.stringContaining('Auto Review stopped this turn after repeated denials.'),
      reason: { review_risk: 'medium', review_circuit_breaker: true },
    });

    const stepCtx: AfterStepContext = {
      turnId: 4,
      step: 1,
      firstStepOfTurn: true,
      signal: defaultSignal,
      usage: emptyUsage(),
      finishReason: 'tool_calls',
      tools: [],
      stopTurn: false,
    };
    await afterStepHooks.run(stepCtx);
    expect(stepCtx.stopTurn).toBe(true);
    expect(stepCtx.stopReason).toBe(AUTO_REVIEW_CIRCUIT_BREAKER_STOP_REASON);

    const callsBefore = runs.length;
    await expect(review(reviewer, 'rm -rf /tmp/y', 4)).resolves.toMatchObject({
      kind: 'decision',
      decision: { decision: 'deny', reason: expect.stringContaining('Turn already stopped') },
    });
    expect(runs).toHaveLength(callsBefore);

    const nextTurnCtx = reviewContext({ id: 'next_turn_deny', toolName: 'Bash', args: { command: 'rm -rf /tmp/z' }, turnId: 5 });
    const nextTurnResolved = await registeredReviewer?.review(nextTurnCtx, {
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    })?.();
    expect(nextTurnResolved?.result).toMatchObject({
      kind: 'deny',
      reason: { review_risk: 'medium' },
    });
    expect(nextTurnResolved?.result).not.toMatchObject({
      reason: { review_circuit_breaker: true },
    });
  });

  it('announces the review before the reviewer answers', async () => {
    holdRuns = true;
    const pending = review();
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(reviewStarts).toHaveLength(1);
    expect(reviewEvents).toHaveLength(0);
    releaseRun();
    await pending;
    expect(reviewEvents).toHaveLength(1);
  });

  it('inherits main human instructions and verified user answers as rootAuthorization for a subagent', async () => {
    agentId = 'worker';
    mainHistory = [
      { role: 'user', content: [{ type: 'text', text: 'Keep the database.' }], origin: { kind: 'user' } },
      {
        role: 'assistant',
        content: [],
        toolCalls: [toolCallFor('q1', 'AskUserQuestion', { questions: [{ header: 'Env', question: 'Clean staging?' }] })],
      },
      { role: 'tool', toolCallId: 'q1', content: [{ type: 'text', text: JSON.stringify({ answers: { Env: 'Yes' } }) }] },
    ];
    history = [{
      role: 'user',
      content: [{ type: 'text', text: 'Delete dist and rebuild.' }],
      origin: { kind: 'system_trigger', name: 'subagent' },
    }];
    await review();
    expect(sentContent()).toContain('rootAuthorization');
    expect(sentContent()).toContain('Keep the database.');
    expect(sentContent()).toContain('Env: Clean staging?');
    expect(sentContent()).toContain('direct-parent-instruction');
    expect(sentContent()).toContain('Delete dist and rebuild.');
  });

  it('does not review Write or Edit', () => {
    const evaluation = { policyName: 'fallback-ask', result: { kind: 'ask' as const } };
    expect(autoReviewTrigger(true, 'yolo', evaluation, 'Write')).toBeUndefined();
    expect(autoReviewTrigger(true, 'auto', evaluation, 'Edit')).toBeUndefined();
    expect(autoReviewTrigger(true, 'yolo', evaluation, 'Bash')).toBe('fallback-ask');
  });

  it('retries a rate limit and keeps the later decision', async () => {
    let calls = 0;
    runError = new APIProviderRateLimitError('Slow down');
    const reviewer = service();
    vi.mocked(runAgentTurn).mockImplementation(async () => {
      calls += 1;
      if (calls < 3 && runError !== undefined) throw runError;
      return {
        agentId: 'reviewer',
        completion: Promise.resolve({ summary: ALLOW, usage: emptyUsage() }),
        partialOutput: () => ALLOW,
      };
    });
    await expect(review(reviewer)).resolves.toMatchObject({ kind: 'decision', decision: { decision: 'allow' } });
    expect(calls).toBe(3);
  });

  it('fails when instructions keep changing or are rewritten during review', async () => {
    const reviewer = service();
    vi.mocked(runAgentTurn).mockImplementation(async () => {
      history = [...history, { role: 'user', content: [{ type: 'text', text: 'More.' }], origin: { kind: 'user' } }];
      return {
        agentId: 'reviewer',
        completion: Promise.resolve({ summary: ALLOW, usage: emptyUsage() }),
        partialOutput: () => ALLOW,
      };
    });
    await expect(review(reviewer)).resolves.toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('changed'),
    });

    history = [
      { role: 'user', content: [{ type: 'text', text: 'Only remove generated files.' }], origin: { kind: 'user' } },
    ];
    const rewriting = service();
    vi.mocked(runAgentTurn).mockImplementation(async () => {
      history = [{ role: 'user', content: [{ type: 'text', text: 'Now delete everything.' }], origin: { kind: 'user' } }];
      return {
        agentId: 'reviewer',
        completion: Promise.resolve({ summary: ALLOW, usage: emptyUsage() }),
        partialOutput: () => ALLOW,
      };
    });
    await expect(review(rewriting)).resolves.toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('changed'),
    });
  });

  it('reviews again once when the user adds an instruction during review', async () => {
    let calls = 0;
    const reviewer = service();
    vi.mocked(runAgentTurn).mockImplementation(async (_handle, request) => {
      calls += 1;
      if (calls === 1) {
        history = [...history, { role: 'user', content: [{ type: 'text', text: 'Also run the tests.' }], origin: { kind: 'user' } }];
      }
      const prompt = request.kind === 'prompt' ? request.prompt : '';
      runs.push({ options: {}, prompt, mode: 'manual' });
      return {
        agentId: 'reviewer',
        completion: Promise.resolve({ summary: ALLOW, usage: emptyUsage() }),
        partialOutput: () => ALLOW,
      };
    });
    await expect(review(reviewer)).resolves.toMatchObject({ kind: 'decision' });
    expect(calls).toBe(2);
    expect(sentContent()).toContain('Also run the tests.');
  });

  it('fails a context overflow without retry and starts compaction', async () => {
    runError = new APIContextOverflowError(400, 'prompt is too long');
    await expect(review()).resolves.toEqual({
      kind: 'failed',
      reason: 'The review context exceeded the model window.',
    });
    expect(runs).toHaveLength(1);
    expect(compactions).toEqual([{ source: 'auto' }]);
  });

  it('does not start another attempt after the review deadline', async () => {
    holdRuns = true;
    const result = review(service(undefined, true, undefined, 20));
    await expect(result).resolves.toMatchObject({ kind: 'failed', reason: 'Review timed out.' });
    expect(runs).toHaveLength(1);
  });

  it('keeps at most four reviews in flight and cancels one still waiting', async () => {
    holdRuns = true;
    const reviewer = service();
    const running = Array.from({ length: 4 }, (_, index) => reviewer.review(
      reviewContext({ id: `run_${index}`, toolName: 'Bash', args: { command: 'pwd' }, tool: bashTool }),
      'fallback-ask',
    ));
    await vi.waitFor(() => expect(runs).toHaveLength(4));
    const reviewAbort = new AbortController();
    const queued = reviewer.review(
      reviewContext({ id: 'queued', toolName: 'Bash', args: { command: 'pwd' }, tool: bashTool }),
      'fallback-ask',
      reviewAbort.signal,
    );
    reviewAbort.abort();
    await expect(queued).resolves.toMatchObject({ kind: 'failed', reason: 'Review cancelled.' });
    expect(runs).toHaveLength(4);
    releaseRun();
    await Promise.all(running);
  });

  it('propagates user cancellation', async () => {
    const controller = new AbortController();
    holdRuns = true;
    const result = service().review(
      reviewContext({ toolName: 'Bash', args: { command: 'rm generated/file' }, signal: controller.signal }),
      'fallback-ask',
    );
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('records the decision telemetry', async () => {
    await review();
    expect(telemetry.at(-1)).toMatchObject({
      event: 'auto_review_decision',
      properties: { decision: 'allow', authorization: 'explicit', model: 'main-model' },
    });
  });
});

interface ReviewContextInput {
  readonly id?: string;
  readonly turnId?: number;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly tool?: ExecutableTool;
}

function reviewContext(input: ReviewContextInput): BeforeToolExecuteEvent {
  const toolCall = toolCallFor(input.id ?? `call_${input.toolName}`, input.toolName, input.args);
  return {
    turnId: input.turnId ?? 0,
    signal: input.signal ?? defaultSignal,
    tool: input.tool,
    toolCall,
    toolCalls: [toolCall],
    args: input.args,
    execution: {
      description: `Approve ${input.toolName}`,
      approvalRule: input.toolName,
      execute: async () => ({ output: '' }),
    },
    reviewSignal: input.signal ?? defaultSignal,
    veto: () => {},
    allow: () => {},
    pass: () => {},
    waitUntil: () => {},
    deferReview: () => {},
    cancelReview: () => {},
  };
}

function toolCallFor(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}
