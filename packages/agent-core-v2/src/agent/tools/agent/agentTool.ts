import { type CollectionView } from '#/_base/di/collection';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import {
  isAbortError,
  isUserCancellation,
  userCancellationReason,
} from '#/_base/utils/abort';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { REPEAT_BREAKER_STOP_REASON } from '#/agent/toolDedupe/toolDedupe';
import type { AgentTaskInfo } from '#/agent/task/types';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  IAgentTaskService,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  isToolActive as evaluateToolActive,
  resolveActiveToolNames,
} from '#/agent/toolPolicy/evaluate';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import {
  AgentToolContribution,
  registerAgentToolService,
} from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService, type ToolReference } from '#/agent/toolRegistry/toolRegistry';
import { type AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import {
  rootDelegationExtras,
  subagentAllowlistFor,
  withoutDelegatingTargets,
} from '#/app/agentProfileCatalog/profile-shared';
import { ILogService } from '#/_base/log/log';
import { hasPinnedPermissionMode } from '#/features/tower/tower';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  isSubagentMeta,
  labelsFromAgentMeta,
  subagentLabels,
  subagentParentAgentId,
  subagentProfileName,
} from '#/session/agentLifecycle/subagentMetadata';
import { type AgentMeta, ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { emitAgentRunSpawned, mirrorAgentRun, SubagentStarted } from '#/session/subagent/mirrorAgentRun';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { FORK_EXPERIMENTAL_UNAVAILABLE, forkIncompatibility } from '#/session/subagent/spawn';
import { SUBAGENT_FORK_FLAG_ID } from '#/session/subagent/flag';
import {
  buildSubagentModelDescriptions,
  exposesSubagentModelChoice,
  formatSubagentTimeoutDescription,
  resolveSubagentTimeoutMs,
  stripSubagentForkParameter,
  stripSubagentModelParameter,
  type SubagentModelSource,
} from '#/session/subagent/configSection';
import {
  BACKGROUND_AGENT_UNAVAILABLE,
  DEFAULT_PROFILE_NAME,
  ISubagentTool,
  RESUME_WITH_TYPE_UNAVAILABLE,
  RESUMED_LABEL,
  SUBAGENT_STOPPED_MESSAGE,
  SubagentToolInputSchema,
  USER_INTERRUPTED_SUBAGENT_MESSAGE,
  type SubagentToolInput,
} from './agent';
import { SubagentTask, type SubagentHandle } from './subagent-task';

import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md?raw';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md?raw';
import AGENT_DESCRIPTION_BASE from './agent.md?raw';
import AGENT_FORK_DESCRIPTION from './agent-fork.md?raw';

const SUBAGENT_TOOL_PARAMETERS = toInputJsonSchema(SubagentToolInputSchema);
const SUBAGENT_TOOL_PARAMETERS_NO_MODEL = stripSubagentModelParameter(SUBAGENT_TOOL_PARAMETERS);

export class SubagentTool implements ISubagentTool {
  declare readonly _serviceBrand: undefined;
  readonly name: string = 'Agent';

  get parameters(): Record<string, unknown> {
    const parameters = exposesSubagentModelChoice(this.config, this.flags)
      ? SUBAGENT_TOOL_PARAMETERS
      : SUBAGENT_TOOL_PARAMETERS_NO_MODEL;
    return this.flags.enabled(SUBAGENT_FORK_FLAG_ID)
      ? parameters
      : stripSubagentForkParameter(parameters);
  }

  private readonly callerAgentId: string;
  private readonly canRunInBackground: () => boolean;
  private catalogReady = false;
  private frozenCatalogProfiles: readonly AgentProfile[] | undefined;

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @ILogService private readonly log: ILogService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @AgentToolContribution private readonly contributions: CollectionView<AgentToolContribution>,
  ) {
    this.callerAgentId = scopeContext.agentId;
    this.canRunInBackground = () =>
      this.toolPolicy.isToolActive('TaskList') &&
      this.toolPolicy.isToolActive('TaskOutput') &&
      this.toolPolicy.isToolActive('TaskStop');
    void this.catalog.ready.then(() => {
      this.catalogReady = true;
    });
  }

  get description(): string {
    const backgroundDescription = this.canRunInBackground()
      ? AGENT_BACKGROUND_DESCRIPTION
      : AGENT_BACKGROUND_DISABLED_DESCRIPTION;
    let description = `${AGENT_DESCRIPTION_BASE}\n\n${backgroundDescription}`;
    if (this.flags.enabled(SUBAGENT_FORK_FLAG_ID)) {
      description += `\n\n${AGENT_FORK_DESCRIPTION}`;
    }
    const own = this.profile.data();
    const catalogProfiles = this.catalogProfiles();
    const allowlist = this.effectiveAllowlist(own, catalogProfiles);
    const profiles =
      allowlist === undefined
        ? catalogProfiles
        : catalogProfiles.filter((profile) => allowlist.includes(profile.name));
    const typeLines = buildProfileDescriptions(
      profiles,
      this.knownToolReferences(),
      (profile, name, source) =>
        this.toolPolicy.isToolActiveForProfile(profile, name, source),
    );
    if (typeLines) {
      description += `\n\nAvailable agent types (pass via subagent_type):\n${typeLines}`;
    }
    const modelLines = buildSubagentModelDescriptions(
      this.config,
      this.flags,
      this.profile.data().modelAlias,
    );
    if (modelLines !== undefined) {
      description += `\n\n${modelLines}`;
    }
    return description;
  }

  private catalogProfiles(): readonly AgentProfile[] {
    if (this.frozenCatalogProfiles !== undefined) return this.frozenCatalogProfiles;
    const profiles = this.catalog.list();
    if (this.catalogReady) this.frozenCatalogProfiles = profiles;
    return profiles;
  }

  private delegationExtras(
    own: {
      readonly profileName?: string;
      readonly subagents?: readonly string[];
    },
    profiles: readonly AgentProfile[],
  ): readonly string[] | undefined {
    if (this.callerAgentId !== 'main') return undefined;
    return rootDelegationExtras(this.catalog, own, profiles);
  }

  private effectiveAllowlist(
    own: {
      readonly profileName?: string;
      readonly subagents?: readonly string[];
    },
    profiles: readonly AgentProfile[],
  ): readonly string[] | undefined {
    const allowlist = subagentAllowlistFor(
      this.catalog,
      own,
      this.delegationExtras(own, profiles),
    );
    if (allowlist === undefined || own.subagents !== undefined) return allowlist;
    return withoutDelegatingTargets(this.catalog, allowlist);
  }

  private knownToolReferences(): ToolReference[] {
    const refs = new Map<string, ToolReference>();
    for (const contribution of this.contributions.items) {
      refs.set(contribution.options.name, {
        name: contribution.options.name,
        source: contribution.options.source ?? 'builtin',
      });
    }
    for (const ref of this.toolRegistry.listReferences()) {
      if (!refs.has(ref.name)) refs.set(ref.name, ref);
    }
    return [...refs.values()];
  }

  async resolveExecution(args: SubagentToolInput): Promise<ToolExecution> {
    const requestedProfileName = args.subagent_type?.length ? args.subagent_type : undefined;
    const resumeAgentId = args.resume?.trim();

    if (
      resumeAgentId !== undefined &&
      resumeAgentId.length > 0 &&
      requestedProfileName !== undefined
    ) {
      return { output: RESUME_WITH_TYPE_UNAVAILABLE, isError: true };
    }

    if (args.fork === true) {
      if (!this.flags.enabled(SUBAGENT_FORK_FLAG_ID)) {
        return { output: FORK_EXPERIMENTAL_UNAVAILABLE, isError: true };
      }
      const forkError = forkIncompatibility(args, this.profile.data());
      if (forkError !== undefined) {
        return { output: forkError, isError: true };
      }
    }

    const profileNameForDisplay =
      resumeAgentId !== undefined && resumeAgentId.length > 0
        ? (await this.resumeProfileName(resumeAgentId)) ?? RESUMED_LABEL
        : (requestedProfileName ??
            (args.fork === true
              ? (this.profile.data().profileName ?? DEFAULT_PROFILE_NAME)
              : DEFAULT_PROFILE_NAME));
    const prefix = args.run_in_background === true ? 'Launching background' : 'Launching';
    return {
      description: `${prefix} ${profileNameForDisplay} agent: ${args.description}`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'agent_call',
        agent_name: profileNameForDisplay,
        prompt: args.prompt,
        background: args.run_in_background,
      },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, profileNameForDisplay),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async resumeProfileName(agentId: string): Promise<string | undefined> {
    const target = this.agentLifecycle.handleOf(agentId);
    if (target !== undefined) return target.accessor.get(IAgentProfileService).data().profileName;
    return subagentProfileName((await this.sessionMetadata.read()).agents?.[agentId]);
  }

  private async launch(
    args: SubagentToolInput,
    toolCallId: string,
    controller: AbortController,
  ): Promise<SubagentHandle> {
    const requester = this.agentLifecycle.handleOf(this.callerAgentId);
    if (requester === undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_FOUND,
        `Caller agent "${this.callerAgentId}" does not exist`,
        { details: { agentId: this.callerAgentId } },
      );
    }

    const resumeAgentId = args.resume?.trim();
    const isResume = resumeAgentId !== undefined && resumeAgentId.length > 0;

    let agentId: string;
    let profileName: string;
    let displayModel: string | undefined;
    let displayModelSource: SubagentModelSource | undefined;
    let promptText = args.prompt;
    if (isResume) {
      const target = await this.resolveResumeTarget(resumeAgentId);
      agentId = target.id;
      const resumed = target.accessor.get(IAgentProfileService).data();
      profileName = resumed.profileName ?? RESUMED_LABEL;
      displayModel = resumed.modelAlias;
    } else {
      const plan = await this.subagents.planSpawn({
        callerAgentId: this.callerAgentId,
        profileName: args.subagent_type,
        model: args.model,
        fork: args.fork === true,
      });
      const spawned = await this.subagents.spawn({
        callerAgentId: this.callerAgentId,
        plan,
        labels: subagentLabels(this.callerAgentId),
        prompt: args.prompt,
      });
      agentId = spawned.agentId;
      profileName = spawned.profileName;
      displayModel = spawned.model;
      displayModelSource = spawned.modelSource;
      promptText = spawned.promptText;
    }

    const target = this.agentLifecycle.handleOf(agentId);
    if (target === undefined) throw new Error(`Agent "${agentId}" does not exist`);
    const run = await this.subagents.run(
      target.accessor.get(IAgentScopeContext).agentContext,
      { kind: 'prompt', prompt: promptText },
      { signal: controller.signal },
    );
    const mirrored = mirrorAgentRun(requester, run, {
      profileName,
      prompt: promptText,
      signal: controller.signal,
      deferStarted: true,
      cancel: (reason) => {
        controller.abort(reason);
      },
    });
    return {
      agentId,
      profileName,
      parentToolCallId: toolCallId,
      model: displayModel,
      modelSource: displayModelSource,
      thinkingEffort: this.agentLifecycle.handleOf(agentId)
        ?.accessor.get(IAgentProfileService)
        .getEffectiveThinkingLevel(),
      completion: mirrored.then((r) => ({
        result: r.summary,
        usage: r.usage,
        stopReason: r.stopReason,
      })),
    };
  }

  private async resolveResumeTarget(agentId: string): Promise<IAgentScopeHandle> {
    const live = this.agentLifecycle.handleOf(agentId);
    const meta = (await this.sessionMetadata.read()).agents?.[agentId];
    if (meta === undefined && live === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent instance "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    if (meta === undefined || !isSubagentMeta(meta)) {
      throw new Error2(ErrorCodes.AGENT_NOT_A_SUBAGENT, `Agent instance "${agentId}" is not a subagent`, {
        details: { agentId },
      });
    }
    if (subagentParentAgentId(meta) !== this.callerAgentId) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_OWNED,
        `Agent instance "${agentId}" does not belong to this parent agent`,
        { details: { agentId, callerAgentId: this.callerAgentId } },
      );
    }
    const target = live ?? (await this.rebuildSubagent(agentId, meta));
    if (target.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        `Agent instance "${agentId}" is already running and cannot run concurrently`,
        { details: { agentId } },
      );
    }
    return target;
  }

  private async rebuildSubagent(agentId: string, meta: AgentMeta): Promise<IAgentScopeHandle> {
    await this.agentLifecycle.create({
      agentId,
      labels: labelsFromAgentMeta(meta),
      forkedFrom: meta.forkedFrom,
    });
    const rebuilt = this.agentLifecycle.handleOf(agentId);
    if (rebuilt === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent instance "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    if (!hasPinnedPermissionMode(rebuilt.accessor.get(IAgentProfileService).data().profileName)) {
      rebuilt.accessor.get(IAgentPermissionModeService).setMode(this.permissionMode.mode);
    }
    this.log.info('subagent rebuilt for resume', { agentId, callerAgentId: this.callerAgentId });
    return rebuilt;
  }

  private async execution(
    args: SubagentToolInput,
    { toolCallId, signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      signal.throwIfAborted();
      const runInBackground = args.run_in_background === true;
      const requestedProfileName = args.subagent_type?.length ? args.subagent_type : undefined;
      const resumeAgentId = args.resume?.trim();
      const isResume = resumeAgentId !== undefined && resumeAgentId.length > 0;

      if (isResume && requestedProfileName !== undefined) {
        return { output: RESUME_WITH_TYPE_UNAVAILABLE, isError: true };
      }

      if (args.fork === true) {
        if (!this.flags.enabled(SUBAGENT_FORK_FLAG_ID)) {
          return { output: FORK_EXPERIMENTAL_UNAVAILABLE, isError: true };
        }
        const forkError = forkIncompatibility(args, this.profile.data());
        if (forkError !== undefined) {
          return { output: forkError, isError: true };
        }
      }

      const allowBackground = this.canRunInBackground();
      if (runInBackground && !allowBackground) {
        return { output: BACKGROUND_AGENT_UNAVAILABLE, isError: true };
      }
      const timeoutMs = resolveSubagentTimeoutMs(this.config);

      const controller = new AbortController();
      const abortBeforeRegister = (): void => {
        controller.abort(signal.reason);
      };
      if (!runInBackground) {
        signal.addEventListener('abort', abortBeforeRegister, { once: true });
      }

      let handle: SubagentHandle;
      try {
        handle = await this.launch(args, toolCallId, controller);
      } catch (error) {
        signal.removeEventListener('abort', abortBeforeRegister);
        this.log.warn('subagent launch failed', {
          toolCallId,
          runInBackground,
          operation: isResume ? 'resume' : 'spawn',
          subagentType: requestedProfileName ?? DEFAULT_PROFILE_NAME,
          resumeAgentId: isResume ? resumeAgentId : undefined,
          error,
        });
        throw error;
      }

      let taskId: string;
      try {
        const registerOptions: RegisterAgentTaskOptions = {
          detached: runInBackground,
          timeoutMs,
          signal: runInBackground ? undefined : signal,
        };
        taskId = this.tasks.registerTask(
          new SubagentTask(handle, args.description, controller),
          registerOptions,
        );
        signal.removeEventListener('abort', abortBeforeRegister);
      } catch (error) {
        controller.abort();
        void handle.completion.catch(() => {});
        signal.removeEventListener('abort', abortBeforeRegister);
        this.log?.warn('background agent task registration failed', {
          toolCallId,
          agentId: handle.agentId,
          subagentType: handle.profileName,
          error,
        });
        const message = error instanceof Error ? error.message : String(error);
        return {
          output:
            isError2(error) && error.code === ErrorCodes.TASK_LIMIT_EXCEEDED
              ? 'Too many background tasks are already running.'
              : message,
          isError: true,
        };
      }

      const requester = this.agentLifecycle.handleOf(this.callerAgentId);
      if (requester !== undefined) {
        emitAgentRunSpawned(requester, handle.agentId, {
          profileName: handle.profileName,
          parentToolCallId: toolCallId,
          description: args.description,
          runInBackground,
          fork: args.fork === true,
          model: handle.model,
          modelSource: handle.modelSource,
          taskId,
        });
        void requester.accessor
          .get(IEventDispatcher)
          ?.dispatch(new SubagentStarted({ subagentId: handle.agentId }));
      }

      if (runInBackground) {
        return {
          output: formatBackgroundAgentResult(taskId, handle, args.description, allowBackground, false),
        };
      }

      const release = await this.tasks.waitForForegroundRelease(taskId);
      if (release === 'detached') {
        return {
          output: formatBackgroundAgentResult(taskId, handle, args.description, allowBackground, true),
        };
      }
      return await this.formatForegroundResult(taskId, handle, timeoutMs);
    } catch (error) {
      return { output: `subagent error: ${launchErrorMessage(error, signal)}`, isError: true };
    }
  }

  private async formatForegroundResult(
    taskId: string,
    handle: SubagentHandle,
    timeoutMs: number,
  ): Promise<ExecutableToolResult> {
    const info = this.tasks.getTask(taskId);
    const stopCode = info?.kind === 'agent' ? info.stopCode : undefined;
    if (info?.status === 'completed') {
      return {
        output: formatForegroundAgentSuccess(handle, await this.tasks.readOutput(taskId), stopCode),
      };
    }
    const timedOut = info?.status === 'timed_out';
    const message = timedOut
      ? `Agent timed out after ${formatSubagentTimeoutDescription(timeoutMs)}.`
      : formatSubagentStoppedMessage(info?.stopReason);
    return {
      output: formatForegroundAgentFailure(handle, message, failureStopReason(info, stopCode)),
      isError: true,
    };
  }
}

type SubagentStopReason =
  | 'completed'
  | 'repeat_breaker'
  | 'max_tokens'
  | 'max_steps'
  | 'filtered'
  | 'provider_error'
  | 'no_final_message'
  | 'cancelled'
  | 'stopped'
  | 'timed_out'
  | 'error';

const REASON_MAX_CHARS = 2000;

const REPEAT_BREAKER_NOTICE =
  'notice: The subagent was stopped by the repeat breaker after issuing the same tool call repeatedly. The summary below is its handoff, not a finished result.';

function resumeHint(agentId: string, prompt: string): string {
  return `resume_hint: Continue with Agent(resume="${agentId}", prompt="${prompt}"). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`;
}

const RESUME_NEXT_STEP =
  'next_step: Resume to continue where it stopped, or take over the task yourself; if neither works, report the failure to the user.';

const NEXT_STEP_BY_REASON: Readonly<Record<SubagentStopReason, string | undefined>> = {
  completed: undefined,
  repeat_breaker:
    'next_step: The subagent was stuck on one tool call. If you resume it, change the instructions or supply the missing input; otherwise continue the work yourself.',
  cancelled: 'next_step: The user stopped this subagent. Do not restart it unless the user asks.',
  filtered:
    'next_step: Resuming is unlikely to help; rephrase or split the task before trying again.',
  max_tokens: RESUME_NEXT_STEP,
  max_steps: RESUME_NEXT_STEP,
  provider_error: RESUME_NEXT_STEP,
  no_final_message: RESUME_NEXT_STEP,
  stopped: RESUME_NEXT_STEP,
  timed_out: RESUME_NEXT_STEP,
  error: RESUME_NEXT_STEP,
};

const STOP_REASON_BY_CODE: Readonly<Record<string, SubagentStopReason>> = {
  [REPEAT_BREAKER_STOP_REASON]: 'repeat_breaker',
  [ErrorCodes.AGENT_MAX_TOKENS_EXCEEDED]: 'max_tokens',
  [ErrorCodes.LOOP_MAX_STEPS_EXCEEDED]: 'max_steps',
  [ErrorCodes.PROVIDER_FILTERED]: 'filtered',
  [ErrorCodes.PROVIDER_RATE_LIMIT]: 'provider_error',
  [ErrorCodes.PROVIDER_API_ERROR]: 'provider_error',
  [ErrorCodes.PROVIDER_OVERLOADED]: 'provider_error',
  [ErrorCodes.PROVIDER_CONNECTION_ERROR]: 'provider_error',
  [ErrorCodes.PROVIDER_AUTH_ERROR]: 'provider_error',
  [ErrorCodes.AGENT_NO_FINAL_MESSAGE]: 'no_final_message',
};

function nextStep(reason: SubagentStopReason): string | undefined {
  return NEXT_STEP_BY_REASON[reason];
}

function failureStopReason(
  info: AgentTaskInfo | undefined,
  stopCode: string | undefined,
): SubagentStopReason {
  if (info?.status === 'timed_out') return 'timed_out';
  if (info?.status === 'killed') {
    return info.stopReason?.trim() === userCancellationReason().message ? 'cancelled' : 'stopped';
  }
  if (stopCode === undefined) return 'error';
  return STOP_REASON_BY_CODE[stopCode] ?? 'error';
}

function truncateReason(reason: string): string {
  if (reason.length <= REASON_MAX_CHARS) return reason;
  return `${reason.slice(0, REASON_MAX_CHARS)}… [truncated]`;
}

registerAgentToolService(ISubagentTool, SubagentTool, {
  name: 'Agent',
  domain: 'subagent',
  requiredRuntimeCapabilities: ['process'],
});

function buildProfileDescriptions(
  profiles: readonly AgentProfile[],
  tools: readonly ToolReference[],
  isToolActive: (
    profile: { readonly tools?: readonly string[]; readonly disallowedTools?: readonly string[] },
    name: string,
    source: ToolReference['source'],
  ) => boolean,
): string {
  return profiles
    .map((profile) => {
      const details = [profile.description, profile.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const header = details.length === 0 ? `- ${profile.name}` : `- ${profile.name}: ${details.join(' ')}`;
      const activeTools = resolveActiveToolNames(profile);
      const externallyRestricted = tools.some(
        (tool) =>
          evaluateToolActive(profile, tool.name, tool.source) &&
          !isToolActive(profile, tool.name, tool.source),
      );
      if (externallyRestricted) {
        const effectiveTools = tools
          .filter((tool) => isToolActive(profile, tool.name, tool.source))
          .map((tool) => tool.name);
        if (effectiveTools.length === 0) {
          return `${header}\n  Tools: none`;
        }
        return `${header}\n  Tools: ${effectiveTools.join(', ')}`;
      }
      if (activeTools === undefined) {
        if ((profile.disallowedTools?.length ?? 0) > 0) {
          return `${header}\n  Tools: all except ${profile.disallowedTools!.join(', ')}`;
        }
        return `${header}\n  Tools: all`;
      }
      if (activeTools.length === 0) {
        return `${header}\n  Tools: none`;
      }
      return `${header}\n  Tools: ${activeTools.join(', ')}`;
    })
    .join('\n');
}

function formatBackgroundAgentResult(
  taskId: string,
  handle: SubagentHandle,
  description: string,
  allowBackground: boolean,
  detachedByUser: boolean,
): string {
  const nextStep = allowBackground
    ? `next_step: The completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user. (If you have nothing to do until it finishes, run such tasks in the foreground next time.)`
    : 'next_step: The completion arrives automatically in a later turn.';
  return [
    `task_id: ${taskId}`,
    'status: running',
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'automatic_notification: true',
    '',
    `description: ${description}`,
    '',
    detachedByUser ? `note: The user moved this subagent to the background.\n${nextStep}` : nextStep,
    `resume_hint: To continue or recover this same subagent later, call Agent(resume="${handle.agentId}", prompt="..."). The parameter is agent_id ("${handle.agentId}"), NOT task_id ("${taskId}") or source_id from a later <notification>. Recovery cases: a later <notification type="task.lost" | "task.failed" | "task.killed"> for this subagent — its conversation history is preserved across session restarts and resume will pick it up.`,
  ].join('\n');
}

function formatForegroundAgentSuccess(
  handle: SubagentHandle,
  result: string,
  stopCode: string | undefined,
): string {
  const reason: SubagentStopReason =
    stopCode === REPEAT_BREAKER_STOP_REASON ? 'repeat_breaker' : 'completed';
  const lines = [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'status: completed',
    `stop_reason: ${reason}`,
  ];
  if (reason === 'repeat_breaker') lines.push(REPEAT_BREAKER_NOTICE);
  lines.push('', '[summary]', result, '', resumeHint(handle.agentId, '...'));
  const next = nextStep(reason);
  if (next !== undefined) lines.push(next);
  return lines.join('\n');
}

function formatForegroundAgentFailure(
  handle: SubagentHandle,
  message: string,
  reason: SubagentStopReason,
): string {
  const lines = [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'status: failed',
    `stop_reason: ${reason}`,
    '',
    `subagent error: ${message}`,
  ];
  if (reason !== 'cancelled') lines.push(resumeHint(handle.agentId, 'continue'));
  const next = nextStep(reason);
  if (next !== undefined) lines.push(next);
  return lines.join('\n');
}

function launchErrorMessage(error: unknown, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) return USER_INTERRUPTED_SUBAGENT_MESSAGE;
  if (isAbortError(error)) return formatSubagentStoppedMessage(errorMessage(signal.reason));
  return error instanceof Error ? error.message : String(error);
}

function formatSubagentStoppedMessage(reason: string | undefined): string {
  const normalized = reason?.trim();
  if (normalized === userCancellationReason().message) return USER_INTERRUPTED_SUBAGENT_MESSAGE;
  if (normalized === undefined || normalized.length === 0) return SUBAGENT_STOPPED_MESSAGE;
  return `${SUBAGENT_STOPPED_MESSAGE} Reason: ${truncateReason(normalized)}`;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return undefined;
}
