import {
  APIProviderRateLimitError,
  isProviderRateLimitError,
  type TokenUsage,
} from '@moonshot-ai/kosong';

import type { Agent } from '../agent';
import type { PromptOrigin } from '../agent/context';
import type { SubagentBinding } from '../config/workspace-local';
import { ErrorCodes, KimiError } from '../errors';
import { DenyAllPermissionPolicy } from '../agent/permission/policies/deny-all';
import { InMemoryAgentRecordPersistence } from '../agent/records';
import { isAbortError } from '../loop/errors';
import {
  DEFAULT_AGENT_PROFILES,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import {
  linkAbortSignal,
  userCancellationReason,
} from '../utils/abort';
import { collectGitContext } from './git-context';
import type { Session } from './index';
import {
  SubagentBatch,
  resolveSwarmMaxConcurrency,
  type SubagentResult,
  type SubagentSuspendedEvent,
  type QueuedSubagentTask,
} from './subagent-batch';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md?raw';

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION = '2 hours';
export const SUBAGENT_MODEL_UNAVAILABLE_MESSAGE =
  'The configured subagent model alias is not resolvable. Check the bindings in .kimi-code/local.toml and your models config.';

const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';

/**
 * Resolve the effective subagent per-task timeout. Precedence:
 * `KIMI_SUBAGENT_TIMEOUT_MS` (integer ms) → `configMs` →
 * `DEFAULT_SUBAGENT_TIMEOUT_MS` (2 hours). `0` means no timeout: the value
 * feeds the background-task manager's per-task timeout (where `0` arms no
 * timer), so it governs foreground and background subagents (and AgentSwarm).
 */
export function resolveSubagentTimeoutMs(configMs?: number): number {
  const raw = process.env[SUBAGENT_TIMEOUT_ENV];
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  if (configMs !== undefined && Number.isInteger(configMs) && configMs >= 0) {
    return configMs;
  }
  return DEFAULT_SUBAGENT_TIMEOUT_MS;
}

/** Human-readable duration for the subagent timeout message. */
export function formatSubagentTimeoutDescription(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    const h = ms / (60 * 60 * 1000);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (ms % (60 * 1000) === 0) {
    const m = ms / (60 * 1000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (ms % 1000 === 0) {
    const s = ms / 1000;
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}

export type {
  SubagentResult as QueuedSubagentRunResult,
  QueuedSubagentTask,
  ResumeQueuedSubagentTask,
  SpawnQueuedSubagentTask,
} from './subagent-batch';

/**
 * A subagent summary shorter than this many characters triggers one
 * follow-up turn that asks the subagent to expand it, so the parent
 * agent receives a technically complete handoff.
 */
const SUMMARY_MIN_LENGTH = 200;
const SUMMARY_CONTINUATION_ATTEMPTS = 1;
const HOOK_TEXT_PREVIEW_LENGTH = 500;
const SUBAGENT_MAX_TOKENS_ERROR =
  'Subagent turn failed before completing its final summary: reason=max_tokens';
const TOOL_CALL_DISABLED_MESSAGE =
  'Tool calls are disabled for side questions. Answer with text only.';
const SUBAGENT_PROMPT_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'subagent' };
const SIDE_QUESTION_SYSTEM_REMINDER = `
This is a side-channel conversation with the user. You should answer user questions directly based on what you already know.

IMPORTANT:
- You are a separate, lightweight instance.
- The main agent continues independently; do not reference being interrupted.
- Do not call any tools. All tool calls are disabled and will be rejected.
  Even though tool definitions are visible in this request, they exist only
  for technical reasons (prompt cache). You must not use them.
- Respond only with text based on what you already know from the conversation
  and this side-channel conversation.
- Follow-up turns may happen in this side-channel conversation.
- If you do not know the answer, say so directly.
`;

export interface RunSubagentOptions {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  /**
   * Spawn-time model override (from workspace binding or profile binding).
   * Spawn precedence: this value > profile binding > inherit the parent.
   * Resume/retry ignore this: the child always keeps its configured model.
   */
  readonly modelAlias?: string;
  /** Spawn-time thinking-effort override; same semantics as `modelAlias`. */
  readonly thinkingEffort?: string;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
  readonly suppressRateLimitFailureEvent?: boolean;
}

export interface SpawnSubagentOptions extends RunSubagentOptions {
  readonly profileName: string;
  readonly swarmItem?: string;
}

/**
 * Read-only access to workspace subagent bindings, injected into the host so
 * the shared spawn path (Agent tool AND AgentSwarm batches) resolves stored
 * type bindings uniformly. Interactive asks and warnings stay at the tool
 * layer — the host only applies (or safely ignores) what is already stored.
 */
export interface SubagentBindingResolver {
  readonly readTypeBinding: (profileName: string) => Promise<SubagentBinding | undefined>;
  readonly isAliasKnown: (alias: string) => boolean;
}

type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
};

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  /** Effective model alias for this run (after override resolution). */
  readonly modelAlias?: string;
  /** Effective thinking effort for this run (after override resolution). */
  readonly thinkingEffort?: string;
  readonly completion: Promise<SubagentCompletion>;
};

export class SessionSubagentHost {
  private readonly activeChildren = new Map<
    string,
    {
      readonly controller: AbortController;
      runInBackground: boolean;
    }
  >();

  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
  ) {}

  private bindingResolver?: SubagentBindingResolver;

  setBindingResolver(resolver: SubagentBindingResolver): void {
    this.bindingResolver = resolver;
  }

  async spawn(options: SpawnSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();

    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const profile = this.resolveProfile(parent, options.profileName);
    // Model/effort precedence: per-run override (slot or explicit) > workspace
    // type binding > profile binding > inherit the parent agent. Bindings are
    // part of the subagent-model-selection experiment and are ignored when it
    // is off. The workspace read lives here — the shared spawn path — so
    // AgentSwarm batches resolve the same stored bindings the Agent tool does.
    const modelSelectionEnabled = parent.experimentalFlags.enabled('subagent-model-selection');
    const workspaceBinding = await this.readWorkspaceTypeBinding(
      parent,
      options,
      modelSelectionEnabled,
    );
    const modelAlias = this.resolveChildModel(
      parent,
      options.modelAlias ??
        workspaceBinding?.model ??
        (modelSelectionEnabled ? profile.modelAlias : undefined),
    );
    const thinkingEffort =
      options.thinkingEffort ??
      workspaceBinding?.thinkingEffort ??
      (modelSelectionEnabled ? profile.thinkingEffort : undefined) ??
      parent.config.thinkingEffort;
    const { id, agent } = await this.session.createAgent(
      { type: 'sub', generate: parent.rawGenerate },
      { parentAgentId: this.ownerAgentId, swarmItem: options.swarmItem },
    );
    const completion = this.runWithActiveChild(id, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, id, profile.name, runOptions, {
        modelAlias,
        thinkingEffort,
      });
      try {
        await this.configureChild(parent, agent, profile, { modelAlias, thinkingEffort });
        return await this.runPromptTurn(parent, id, agent, profile.name, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, id, runOptions, error);
        throw error;
      }
    });
    return {
      agentId: id,
      profileName: profile.name,
      resumed: false,
      modelAlias,
      thinkingEffort,
      completion,
    };
  }

  async resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const { child, profileName } = await this.ensureIdleSubagent(agentId, parent);
    // Sticky resume is part of the subagent-model-selection experiment: with
    // the flag on, a resumed child always keeps its configured model/effort
    // (no mid-conversation switches); with it off, resume realigns the child
    // to the parent's current model exactly as before.
    const sticky = parent.experimentalFlags.enabled('subagent-model-selection');
    const modelAlias = sticky
      ? this.resolveChildModel(parent, child.config.modelAlias)
      : parent.config.modelAlias;
    // Effort is never touched on resume (same as the pre-change behavior);
    // the child keeps whatever it was configured with at spawn.
    const thinkingEffort = child.config.thinkingEffort;
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      this.emitSubagentSpawned(parent, agentId, profileName, runOptions, {
        modelAlias,
        thinkingEffort,
      });
      try {
        child.config.update({ modelAlias, thinkingEffort });
        return await this.runPromptTurn(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, runOptions, error);
        throw error;
      }
    });
    return { agentId, profileName, resumed: true, modelAlias, thinkingEffort, completion };
  }

  async retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const { child, profileName } = await this.ensureIdleSubagent(agentId, parent);
    // Sticky semantics, same as resume().
    const sticky = parent.experimentalFlags.enabled('subagent-model-selection');
    const modelAlias = sticky
      ? this.resolveChildModel(parent, child.config.modelAlias)
      : parent.config.modelAlias;
    const thinkingEffort = child.config.thinkingEffort;
    const completion = this.runWithActiveChild(agentId, options, async (runOptions) => {
      try {
        runOptions.signal.throwIfAborted();
        child.config.update({ modelAlias, thinkingEffort });
        this.emitSubagentStarted(parent, agentId);
        const turnId = child.turn.retry('agent-host');
        if (turnId === null) {
          throw new Error(`Agent instance "${agentId}" could not start a retry turn`);
        }
        this.observeFirstRequest(child, runOptions);
        return await this.waitForChildCompletion(parent, agentId, child, profileName, runOptions);
      } catch (error) {
        this.emitSubagentFailed(parent, agentId, runOptions, error);
        throw error;
      }
    });
    return { agentId, profileName, resumed: true, modelAlias, thinkingEffort, completion };
  }

  private async ensureIdleSubagent(
    agentId: string,
    parent: Agent,
  ): Promise<{ readonly parent: Agent; readonly child: Agent; readonly profileName: string }> {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub') {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (metadata.parentAgentId !== this.ownerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
    const child = await this.session.ensureAgentResumed(agentId);
    if (this.activeChildren.has(agentId) || child.turn.hasActiveTurn) {
      throw new Error(`Agent instance "${agentId}" is already running and cannot run concurrently`);
    }

    const profileName = child.config.profileName ?? 'subagent';
    return { parent, child, profileName };
  }

  async runQueued<T>(tasks: readonly QueuedSubagentTask<T>[]): Promise<Array<SubagentResult<T>>> {
    const maxConcurrency = resolveSwarmMaxConcurrency();
    return new SubagentBatch(this, tasks, { maxConcurrency }).run();
  }

  suspended(event: SubagentSuspendedEvent): void {
    const parent = this.session.getReadyAgent?.(this.ownerAgentId);
    parent?.emitEvent({
      type: 'subagent.suspended',
      subagentId: event.agentId,
      reason: event.reason,
    });
  }

  async startBtw(): Promise<string> {
    const parent = await this.session.ensureAgentResumed(this.ownerAgentId);
    const { id, agent: child } = await this.session.createAgent(
      {
        type: 'sub',
        generate: parent.rawGenerate,
        persistence: new InMemoryAgentRecordPersistence(),
      },
      { parentAgentId: this.ownerAgentId, persistMetadata: false },
    );

    child.config.update({
      modelAlias: parent.config.modelAlias,
      thinkingEffort: parent.config.thinkingEffort,
      systemPrompt: parent.config.systemPrompt,
    });
    child.tools.copyLoopToolsFrom(parent.tools);
    child.context.useProjectedHistoryFrom(parent.context);
    child.context.appendSystemReminder(SIDE_QUESTION_SYSTEM_REMINDER.trim(), {
      kind: 'system_trigger',
      name: 'btw',
    });
    child.permission.policies.unshift(new DenyAllPermissionPolicy(TOOL_CALL_DISABLED_MESSAGE));
    return id;
  }

  cancelAll(reason: unknown = userCancellationReason()): void {
    const foregroundChildren = Array.from(this.activeChildren).filter(
      ([, child]) => !child.runInBackground,
    );
    for (const [childId, child] of foregroundChildren) {
      this.session.getReadyAgent(childId)?.subagentHost?.cancelAll(reason);
      // Abort with the cancel reason (a user interruption by default) so the
      // subagent's in-flight tools report the cause accurately to the model.
      child.controller.abort(reason);
    }
  }

  markActiveChildDetached(agentId: string): void {
    const child = this.activeChildren.get(agentId);
    if (child !== undefined) child.runInBackground = true;
  }

  async getProfileName(agentId: string): Promise<string | undefined> {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return (await this.session.ensureAgentResumed(agentId)).config.profileName;
  }

  getSwarmItem(agentId: string): string | undefined {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return metadata.swarmItem;
  }

  private resolveProfile(parent: Agent, profileName: string): ResolvedAgentProfile {
    const profile =
      DEFAULT_AGENT_PROFILES[parent.config.profileName ?? 'agent']?.subagents?.[profileName] ??
      DEFAULT_AGENT_PROFILES['agent']?.subagents?.[profileName];
    if (profile === undefined) {
      throw new Error(`Subagent profile "${profileName}" was not found`);
    }
    return profile;
  }

  /**
   * Stored workspace type binding for the shared spawn path. Skipped when the
   * caller passed an explicit per-run override (slot/type resolution at the
   * tool layer wins), when the experiment is off, or when no resolver is
   * wired. A stored alias that no longer resolves is ignored with a log
   * warning — the host cannot ask; interactive repair stays at the tool
   * layer.
   */
  private async readWorkspaceTypeBinding(
    parent: Agent,
    options: SpawnSubagentOptions,
    modelSelectionEnabled: boolean,
  ): Promise<SubagentBinding | undefined> {
    if (options.modelAlias !== undefined || !modelSelectionEnabled) return undefined;
    if (this.bindingResolver === undefined) return undefined;
    const binding = await this.bindingResolver.readTypeBinding(options.profileName);
    if (binding === undefined || binding.inherit === true) return undefined;
    if (binding.model !== undefined && !this.bindingResolver.isAliasKnown(binding.model)) {
      parent.log?.warn('ignoring workspace binding with unknown model alias', {
        profileName: options.profileName,
        modelAlias: binding.model,
      });
      return undefined;
    }
    return binding;
  }

  private runWithActiveChild(
    childId: string,
    options: RunSubagentOptions,
    run: (options: RunSubagentOptions) => Promise<SubagentCompletion>,
  ): Promise<SubagentCompletion> {
    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(childId, {
      controller,
      runInBackground: options.runInBackground,
    });

    return run({ ...options, signal: controller.signal }).finally(() => {
      unlinkAbortSignal();
      this.activeChildren.delete(childId);
    });
  }

  private async runPromptTurn(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    options.signal.throwIfAborted();
    await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
    options.signal.throwIfAborted();

    let childPrompt = options.prompt;
    if (profileName === 'explore') {
      const gitContext = await collectGitContext(child.kaos, child.config.cwd);
      if (gitContext) childPrompt = `${gitContext}\n\n${childPrompt}`;
    }

    this.emitSubagentStarted(parent, childId);
    const turnId = child.turn.prompt([{ type: 'text', text: childPrompt }], SUBAGENT_PROMPT_ORIGIN);
    if (turnId === null) {
      throw new Error(`Agent instance "${childId}" could not start a turn`);
    }
    this.observeFirstRequest(child, options);
    return this.waitForChildCompletion(parent, childId, child, profileName, options);
  }

  private async waitForChildCompletion(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
  ): Promise<SubagentCompletion> {
    await runChildTurnToCompletion(child, options.signal);
    await this.drainChildBackgroundTasks(child, options.signal);

    // A subagent that returns an overly terse summary leaves the parent
    // agent under-informed. Give it a bounded number of chances to expand
    // the handoff; if it is still short after that, accept it as-is rather
    // than retrying indefinitely.
    let result = lastAssistantText(child);
    let remainingContinuations = SUMMARY_CONTINUATION_ATTEMPTS;
    while (remainingContinuations > 0 && result.length < SUMMARY_MIN_LENGTH) {
      remainingContinuations -= 1;
      options.signal.throwIfAborted();
      child.turn.prompt([{ type: 'text', text: SUMMARY_CONTINUATION_PROMPT }], SUBAGENT_PROMPT_ORIGIN);
      await runChildTurnToCompletion(child, options.signal);
      result = lastAssistantText(child);
    }
    const usage = child.usage.data().total;
    parent.emitEvent({
      type: 'subagent.completed',
      subagentId: childId,
      resultSummary: result,
      usage,
      contextTokens: child.context.tokenCount,
    });
    this.triggerSubagentStop(parent, profileName, result);
    return { result, usage };
  }

  private async configureChild(
    parent: Agent,
    child: Agent,
    profile: ResolvedAgentProfile,
    overrides: { readonly modelAlias?: string; readonly thinkingEffort?: string },
  ): Promise<void> {
    // Model/effort are resolved by the caller (per-run override > profile
    // binding > parent inheritance).
    child.config.update({
      cwd: parent.config.cwd,
      modelAlias: overrides.modelAlias,
      thinkingEffort: overrides.thinkingEffort,
    });

    const context = await prepareSystemPromptContext(
      this.session.systemContextKaos(child.kaos.getcwd()),
      this.session.options.kimiHomeDir,
      { additionalDirs: child.getAdditionalDirs() },
    );
    child.useProfile(profile, context, this.session.options.kimiHomeDir);
    child.tools.inheritUserTools(parent.tools);
  }

  private resolveChildModel(parent: Agent, requestedModelAlias?: string): string {
    const modelAlias = requestedModelAlias ?? parent.config.modelAlias;
    if (modelAlias === undefined) throw new Error('Caller agent has no model bound');
    try {
      parent.modelProvider?.resolveProviderConfig(modelAlias);
    } catch (error) {
      throw new KimiError(ErrorCodes.CONFIG_INVALID, SUBAGENT_MODEL_UNAVAILABLE_MESSAGE, {
        cause: error,
      });
    }
    return modelAlias;
  }

  /**
   * Hold the run open until the child agent's background tasks (background
   * Bash, nested background agents) settle — the print-mode (`kimi -p`)
   * drain semantics applied to subagent completion. Drained tasks get their
   * terminal notifications suppressed: without that, a task outliving the
   * child's final turn steers a fresh turn on the finished subagent
   * (`steer` degrades to `launch`), which runs unobserved and whose output
   * never reaches the parent. Bounded by the run's signal — the Agent
   * tool's per-run timeout / user-cancel envelope covers the drain too.
   */
  private async drainChildBackgroundTasks(child: Agent, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      await this.suppressChildTaskNotifications(child);
      await child.background.waitForActiveTasks(() => true, { signal });
      // Suppress again after the wait: notification delivery re-checks
      // suppression after its async output snapshot, so this pass still
      // blocks notifications for tasks that settled during the wait.
      await this.suppressChildTaskNotifications(child);
      // A terminal effect that slipped past the suppression race may have
      // steered a follow-up turn onto the child; let it finish (it can fan
      // out new tasks) before declaring the child drained.
      if (child.turn.hasActiveTurn) {
        await runChildTurnToCompletion(child, signal);
        continue;
      }
      if (child.background.list(true).length === 0) return;
    }
  }

  /**
   * Suppress terminal notifications for every child background task —
   * including already-settled ones whose notification may still be in
   * flight. `list(false)` is required: the active-only list drops a task
   * the moment it terminates, which is exactly when an unsuppressed
   * notification can still steer an orphan turn onto the finished child.
   */
  private async suppressChildTaskNotifications(child: Agent): Promise<void> {
    for (const task of child.background.list(false)) {
      await child.background.suppressTerminalNotification(task.taskId);
    }
  }

  private async triggerSubagentStart(
    parent: Agent,
    profileName: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    await parent.hooks?.trigger('SubagentStart', {
      matcherValue: profileName,
      signal,
      inputData: {
        agentName: profileName,
        prompt: prompt.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private triggerSubagentStop(parent: Agent, profileName: string, result: string): void {
    void parent.hooks?.fireAndForgetTrigger('SubagentStop', {
      matcherValue: profileName,
      inputData: {
        agentName: profileName,
        response: result.slice(0, HOOK_TEXT_PREVIEW_LENGTH),
      },
    });
  }

  private observeFirstRequest(
    child: Agent,
    options: RunSubagentOptions,
  ): void {
    if (options.onReady === undefined) return;
    void child.turn
      .waitForTurnFirstRequest()
      .then(() => {
        options.onReady?.();
      })
      .catch(() => {});
  }

  private emitSubagentSpawned(
    parent: Agent,
    childId: string,
    profileName: string,
    options: RunSubagentOptions,
    effective: { readonly modelAlias?: string; readonly thinkingEffort?: string },
  ): void {
    parent.emitEvent({
      type: 'subagent.spawned',
      subagentId: childId,
      subagentName: profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      parentAgentId: this.ownerAgentId,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
      modelAlias: effective.modelAlias,
      thinkingEffort: effective.thinkingEffort,
    });
    parent.telemetry.track('subagent_created', {
      agent_id: childId,
      parent_agent_id: this.ownerAgentId,
      parent_tool_call_id: options.parentToolCallId ?? '',
      subagent_name: profileName,
      run_in_background: options.runInBackground,
    });
  }

  private emitSubagentStarted(
    parent: Agent,
    childId: string,
  ): void {
    parent.emitEvent({
      type: 'subagent.started',
      subagentId: childId,
    });
  }

  private emitSubagentFailed(
    parent: Agent,
    childId: string,
    options: RunSubagentOptions,
    error: unknown,
  ): void {
    if (shouldSuppressQueuedAttemptFailureEvent(options, error)) return;
    parent.emitEvent({
      type: 'subagent.failed',
      subagentId: childId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {
  const completion = await child.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
    if (turnEnded.error?.code === ErrorCodes.PROVIDER_FILTERED) {
      throw new Error('Subagent turn blocked by provider safety policy');
    }
    if (turnEnded.error?.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
      throw providerRateLimitErrorFromPayload(turnEnded.error);
    }
    throw new Error(
      turnEnded.error === undefined
        ? `Subagent turn ${turnEnded.reason}`
        : `[${turnEnded.error.code}] ${turnEnded.error.message}`,
    );
  }
  if (completion.stopReason === 'max_tokens') {
    throw new Error(`${SUBAGENT_MAX_TOKENS_ERROR}.`);
  }
}

function providerRateLimitErrorFromPayload(error: {
  readonly message: string;
  readonly details?: Record<string, unknown>;
}): APIProviderRateLimitError {
  const requestId =
    typeof error.details?.['requestId'] === 'string' ? error.details['requestId'] : null;
  return new APIProviderRateLimitError(error.message, requestId);
}

function lastAssistantText(agent: Agent): string {
  for (const message of [...agent.context.history].toReversed()) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text.trim().length > 0) return text.trim();
  }
  return '';
}

function shouldSuppressQueuedAttemptFailureEvent(
  options: RunSubagentOptions,
  error: unknown,
): boolean {
  if (options.suppressRateLimitFailureEvent !== true) return false;
  if (isProviderRateLimitError(error)) return true;
  return isAbortError(error) || options.signal.aborted;
}
