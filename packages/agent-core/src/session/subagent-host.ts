import type { TokenUsage } from '@moonshot-ai/kosong';

import type { Agent } from '../agent';
import type { PromptOrigin } from '../agent/context';
import type { LoopTurnStopReason } from '../loop';
import { isAbortError } from '../loop/errors';
import {
  DEFAULT_AGENT_PROFILES,
  prepareSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import type { AgentEvent } from '../rpc';
import {
  createDeadlineAbortSignal,
  isUserCancellation,
  linkAbortSignal,
  userCancellationReason,
} from '../utils/abort';
import { collectGitContext } from './git-context';
import type { Session } from './index';
import {
  SubagentLaunchQueue,
  formatTimeoutMs,
  isRateLimit429Error,
  totalTimeoutMessage,
  type QueuedSubagentAttemptOutcome,
  type QueuedSubagentRunOptions,
  type QueuedSubagentRunResult,
  type QueuedSubagentTask,
} from './subagent-launch-queue';
import SUMMARY_CONTINUATION_PROMPT from './summary-continuation.md';

export type {
  QueuedSubagentRunOptions,
  QueuedSubagentRunResult,
  QueuedSubagentTask,
} from './subagent-launch-queue';

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

type RunSubagentOptions = {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly runInBackground: boolean;
  readonly origin?: PromptOrigin;
  readonly signal: AbortSignal;
  readonly onFirstOutput?: () => void;
};

type SpawnSubagentOptions = RunSubagentOptions & {
  readonly profileName: string;
};

type SubagentCompletion = {
  readonly result: string;
  readonly usage?: TokenUsage;
};

type ActiveChild = {
  readonly controller: AbortController;
  readonly runInBackground: boolean;
};

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly completion: Promise<SubagentCompletion>;
};

export class SessionSubagentHost {
  private readonly activeChildren = new Map<string, ActiveChild>();
  readonly launchQueue: SubagentLaunchQueue;

  constructor(
    private readonly session: Session,
    private readonly ownerAgentId: string,
    readonly backgroundTaskTimeoutMs?: number | undefined,
  ) {
    this.launchQueue = new SubagentLaunchQueue(this);
  }

  async spawn(options: SpawnSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const parent = this.requireParentAgent();
    const profile = this.resolveProfile(parent, options.profileName);
    const { id, agent } = await this.session.createAgent(
      { type: 'sub', generate: parent.rawGenerate },
      undefined,
      this.ownerAgentId,
    );
    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(id, {
      controller,
      runInBackground: options.runInBackground,
    });

    this.emitSubagentSpawned(parent, id, profile.name, options);
    const completion = this.runChild(
      parent,
      id,
      agent,
      profile.name,
      {
        ...options,
        signal: controller.signal,
      },
      () => this.configureChild(parent, agent, profile),
      false,
    ).finally(() => {
      unlinkAbortSignal();
      this.activeChildren.delete(id);
    });
    return {
      agentId: id,
      profileName: profile.name,
      resumed: false,
      completion,
    };
  }

  async resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle> {
    options.signal.throwIfAborted();
    const parent = this.requireParentAgent();
    const child = this.session.agents.get(agentId);
    if (child === undefined) {
      throw new Error(`Agent instance "${agentId}" was not found`);
    }
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub') {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (metadata.parentAgentId !== this.ownerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
    if (this.activeChildren.has(agentId) || child.turn.hasActiveTurn) {
      throw new Error(
        `Agent instance "${agentId}" is already running and cannot be resumed concurrently`,
      );
    }

    const profileName = child.config.profileName ?? 'subagent';

    const controller = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(options.signal, controller);
    this.activeChildren.set(agentId, {
      controller,
      runInBackground: options.runInBackground,
    });

    const completion = this.runChild(
      parent,
      agentId,
      child,
      profileName,
      {
        ...options,
        signal: controller.signal,
      },
      // A resumed subagent is realigned to the parent agent's current model,
      // so a parent setModel between the initial spawn and the resume is
      // reflected — a subagent always uses the parent agent's model.
      () => {
        child.config.update({ modelAlias: parent.config.modelAlias });
        return Promise.resolve();
      },
    ).finally(() => {
      unlinkAbortSignal();
      this.activeChildren.delete(agentId);
    });

    return {
      agentId,
      profileName,
      resumed: true,
      completion,
    };
  }

  async runQueued<T>(
    tasks: readonly QueuedSubagentTask<T>[],
    options: QueuedSubagentRunOptions,
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    return await this.launchQueue.run(tasks, options);
  }

  cancelAll(reason: unknown = userCancellationReason()): void {
    const foregroundChildren = Array.from(this.activeChildren).filter(
      ([, child]) => !child.runInBackground,
    );
    for (const [childId, child] of foregroundChildren) {
      this.session.agents.get(childId)?.subagentHost?.cancelAll(reason);
      // Abort with the cancel reason (a user interruption by default) so the
      // subagent's in-flight tools report the cause accurately to the model.
      child.controller.abort(reason);
    }
  }

  getProfileName(agentId: string): string | undefined {
    const metadata = this.session.metadata.agents[agentId];
    if (metadata?.type !== 'sub' || metadata.parentAgentId !== this.ownerAgentId) {
      return undefined;
    }
    return this.session.agents.get(agentId)?.config.profileName;
  }

  async runQueuedTaskAttempt<T>(
    task: QueuedSubagentTask<T>,
    options: QueuedSubagentRunOptions,
    totalTimedOut: () => boolean,
    markReady: () => void,
  ): Promise<QueuedSubagentAttemptOutcome<T>> {
    const subagentDeadline =
      options.timeoutMs === undefined
        ? undefined
        : createDeadlineAbortSignal(options.signal, options.timeoutMs);
    const runSignal = subagentDeadline?.signal ?? options.signal;
    let handle: SubagentHandle | undefined;
    try {
      runSignal.throwIfAborted();
      handle = await this.spawn({
        ...task,
        signal: runSignal,
        onFirstOutput: markReady,
      });
      const completion = await handle.completion;
      return {
        task,
        agentId: handle.agentId,
        status: 'completed',
        result: completion.result,
        usage: completion.usage,
      };
    } catch (error) {
      if (isRateLimit429Error(error)) {
        return 'rate_limited';
      }
      if (handle === undefined) {
        throw error;
      }
      let message: string;
      if (subagentDeadline?.timedOut() === true && options.timeoutMs !== undefined) {
        message = `Subagent timed out after ${formatTimeoutMs(options.timeoutMs)}.`;
      } else if (totalTimedOut() && options.totalTimeoutMs !== undefined) {
        message = totalTimeoutMessage(options.totalTimeoutMs);
      } else if (isUserCancellation(runSignal.reason)) {
        message = 'The user manually interrupted this subagent batch.';
      } else if (isAbortError(error)) {
        message = 'The subagent was stopped before it finished.';
      } else {
        message = error instanceof Error ? error.message : String(error);
      }
      return {
        task,
        agentId: handle.agentId,
        status: 'failed',
        error: message,
      };
    } finally {
      subagentDeadline?.clear();
    }
  }

  private requireParentAgent(): Agent {
    const parent = this.session.agents.get(this.ownerAgentId);
    if (parent === undefined) {
      throw new Error(`Parent agent "${this.ownerAgentId}" was not found`);
    }
    return parent;
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

  private async runChild(
    parent: Agent,
    childId: string,
    child: Agent,
    profileName: string,
    options: RunSubagentOptions,
    prepareChild: () => Promise<void>,
    emitSpawnedEvent = true,
  ): Promise<SubagentCompletion> {
    if (emitSpawnedEvent) this.emitSubagentSpawned(parent, childId, profileName, options);
    const unwatchFirstOutput = this.watchFirstOutput(child, options.onFirstOutput);

    try {
      await prepareChild();
      options.signal.throwIfAborted();
      await this.triggerSubagentStart(parent, profileName, options.prompt, options.signal);
      options.signal.throwIfAborted();

      // Explore subagents start cold; a git-context block helps them orient
      // in the repository before searching.
      let childPrompt = options.prompt;
      if (profileName === 'explore') {
        const gitContext = await collectGitContext(child.kaos, child.config.cwd);
        if (gitContext) childPrompt = `${gitContext}\n\n${childPrompt}`;
      }
      const origin: PromptOrigin = options.origin ?? { kind: 'system_trigger', name: 'subagent' };
      this.emitSubagentStarted(parent, childId, profileName, options);
      child.turn.prompt([{ type: 'text', text: childPrompt }], origin);
      await runChildTurnToCompletion(child, options.signal);

      // A subagent that returns an overly terse summary leaves the parent
      // agent under-informed. Give it a bounded number of chances to expand
      // the handoff; if it is still short after that, accept it as-is rather
      // than retrying indefinitely.
      let result = lastAssistantText(child);
      let remainingContinuations = SUMMARY_CONTINUATION_ATTEMPTS;
      while (remainingContinuations > 0 && result.length < SUMMARY_MIN_LENGTH) {
        remainingContinuations -= 1;
        options.signal.throwIfAborted();
        child.turn.prompt([{ type: 'text', text: SUMMARY_CONTINUATION_PROMPT }], origin);
        await runChildTurnToCompletion(child, options.signal);
        result = lastAssistantText(child);
      }
      const usage = child.usage.data().total;
      parent.emitEvent({
        type: 'subagent.completed',
        subagentId: childId,
        parentToolCallId: options.parentToolCallId,
        resultSummary: result,
        usage,
        contextTokens: child.context.tokenCount,
      });
      this.triggerSubagentStop(parent, profileName, result);
      return { result, usage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      parent.emitEvent({
        type: 'subagent.failed',
        subagentId: childId,
        parentToolCallId: options.parentToolCallId,
        error: message,
      });
      throw error;
    } finally {
      unwatchFirstOutput?.();
    }
  }

  private async configureChild(
    parent: Agent,
    child: Agent,
    profile: ResolvedAgentProfile,
  ): Promise<void> {
    // A subagent always inherits the parent agent's model.
    child.config.update({
      cwd: parent.config.cwd,
      modelAlias: parent.config.modelAlias,
      thinkingLevel: parent.config.thinkingLevel,
    });

    const context = await prepareSystemPromptContext(child.kaos);
    child.useProfile(profile, context);
    child.tools.inheritUserTools(parent.tools);
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

  private watchFirstOutput(
    child: Agent,
    onFirstOutput: (() => void) | undefined,
  ): (() => void) | undefined {
    if (onFirstOutput === undefined) return undefined;
    let emitted = false;
    return child.onEvent((event) => {
      if (emitted || !isFirstOutputEvent(event)) return;
      emitted = true;
      onFirstOutput();
    });
  }

  private emitSubagentSpawned(
    parent: Agent,
    childId: string,
    profileName: string,
    options: RunSubagentOptions,
  ): void {
    parent.emitEvent({
      type: 'subagent.spawned',
      subagentId: childId,
      subagentName: profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      parentAgentId: this.ownerAgentId,
      description: options.description,
      runInBackground: options.runInBackground,
    });
    parent.telemetry.track('subagent_created', {
      subagent_name: profileName,
      run_in_background: options.runInBackground,
    });
  }

  private emitSubagentStarted(
    parent: Agent,
    childId: string,
    profileName: string,
    options: RunSubagentOptions,
  ): void {
    parent.emitEvent({
      type: 'subagent.started',
      subagentId: childId,
      subagentName: profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      parentAgentId: this.ownerAgentId,
      description: options.description,
      runInBackground: options.runInBackground,
    });
  }
}

async function runChildTurnToCompletion(child: Agent, signal: AbortSignal): Promise<void> {
  const completion = await child.turn.waitForCurrentTurn(signal);
  const turnEnded = completion.event;
  if (turnEnded.reason !== 'completed') {
    throw new Error(
      turnEnded.error === undefined
        ? `Subagent turn ${turnEnded.reason}`
        : `[${turnEnded.error.code}] ${turnEnded.error.message}`,
    );
  }
  throwIfSubagentStoppedAtMaxTokens(completion.stopReason);
}

function throwIfSubagentStoppedAtMaxTokens(stopReason: LoopTurnStopReason | undefined): void {
  if (stopReason === 'max_tokens') {
    throw new Error(`${SUBAGENT_MAX_TOKENS_ERROR}.`);
  }
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

function isFirstOutputEvent(event: AgentEvent): boolean {
  switch (event.type) {
    case 'assistant.delta':
    case 'thinking.delta':
      return event.delta.length > 0;
    case 'tool.call.delta':
      return (event.name?.length ?? 0) > 0 || (event.argumentsPart?.length ?? 0) > 0;
    case 'tool.call.started':
      return true;
    default:
      return false;
  }
}
