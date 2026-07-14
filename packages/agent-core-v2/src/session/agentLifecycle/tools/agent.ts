/**
 * `agentLifecycle` domain (L6) — the `Agent` collaboration tool.
 *
 * The LLM-facing wrapper over `IAgentLifecycleService`: translates the tool
 * args into a Profile + Model binding, creates (or resumes) an agent, drives
 * one turn via `run`, and mirrors the run onto the calling agent's record
 * stream (`mirrorAgentRun`). The tool also owns the JSON schema + description,
 * approval rule, background-task registration (so the LLM can see the run
 * under TaskList/TaskOutput/TaskStop when `run_in_background=true` or after
 * detach), and terminal text formatting.
 *
 * Registered via the module-level `registerTool(AgentTool)` at the bottom of
 * this file — the same "import = register" pattern used by every builtin tool.
 */

import { z } from 'zod';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { isUserCancellation } from '#/_base/utils/abort';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  IAgentTaskService,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { isAbortError } from '#/_base/utils/abort';
import {
  ToolAccesses,
  type BuiltinTool,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import { IAgentProfileCatalogService, type AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import { ILogService } from '#/_base/log/log';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { IAgentLifecycleService } from '../agentLifecycle';
import { emitAgentRunSpawned, mirrorAgentRun } from '../mirrorAgentRun';
import { isSubagentMeta, subagentLabels, subagentParentAgentId } from '../subagentMetadata';
import { SubagentTask, type SubagentHandle } from './subagent-task';

import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md?raw';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md?raw';
import AGENT_DESCRIPTION_BASE from './agent.md?raw';

const DEFAULT_PROFILE_NAME = 'coder';
const RESUMED_LABEL = 'subagent';
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION = '30 minutes';

export const AgentToolInputSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const record = input as Record<string, unknown>;
    const normalized = { ...record };
    const hasResumeId =
      typeof normalized['resume'] === 'string' && normalized['resume'].trim().length > 0;
    const hasSubagentType =
      typeof normalized['subagent_type'] === 'string' && normalized['subagent_type'].length > 0;
    if (!hasSubagentType && !hasResumeId) {
      normalized['subagent_type'] = DEFAULT_PROFILE_NAME;
    } else if (!hasSubagentType) {
      delete normalized['subagent_type'];
    }
    return normalized;
  },
  z.object({
    prompt: z.string().describe('Full task prompt for the subagent'),
    description: z.string().describe('Short task description (3-5 words) for UI display'),
    subagent_type: z
      .string()
      .optional()
      .describe(
        'One of the available agent types (see "Available agent types" in this tool description). Defaults to "coder" when omitted.',
      ),
    resume: z
      .string()
      .optional()
      .describe(
        'Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        'If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.',
      ),
  }),
);

export type AgentToolInput = z.infer<typeof AgentToolInputSchema>;


export const AgentToolOutputSchema = z.object({
  result: z.string().describe('Aggregated text output from the subagent'),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative().optional(),
      cache_write: z.number().int().nonnegative().optional(),
    })
    .describe('Cumulative token usage'),
});

export type AgentToolOutput = z.infer<typeof AgentToolOutputSchema>;

const BACKGROUND_AGENT_UNAVAILABLE =
  'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.';
const RESUME_WITH_TYPE_UNAVAILABLE =
  'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.';
const USER_INTERRUPTED_SUBAGENT_MESSAGE =
  "The user manually interrupted this subagent (and any sibling agents launched alongside it). This was a deliberate user action, not a system error, a timeout, or a capacity/concurrency limit. Do not retry automatically or speculate about why it failed — wait for the user's next instruction.";


export class AgentTool implements BuiltinTool<AgentToolInput> {
  readonly name: string = 'Agent';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentToolInputSchema);

  private readonly callerAgentId: string;
  private readonly canRunInBackground: () => boolean;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @IAgentProfileCatalogService private readonly catalog: IAgentProfileCatalogService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @ILogService private readonly log: ILogService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
  ) {
    this.callerAgentId = scopeContext.agentId;
    this.canRunInBackground = () =>
      this.profile.isToolActive('TaskList') &&
      this.profile.isToolActive('TaskOutput') &&
      this.profile.isToolActive('TaskStop');
  }

  get description(): string {
    const backgroundDescription = this.canRunInBackground()
      ? AGENT_BACKGROUND_DESCRIPTION
      : AGENT_BACKGROUND_DISABLED_DESCRIPTION;
    const baseDescription = `${AGENT_DESCRIPTION_BASE}\n\n${backgroundDescription}`;
    const typeLines = buildProfileDescriptions(this.catalog.list());
    return typeLines
      ? `${baseDescription}\n\nAvailable agent types (pass via subagent_type):\n${typeLines}`
      : baseDescription;
  }

  async resolveExecution(args: AgentToolInput): Promise<ToolExecution> {
    const requestedProfileName = args.subagent_type?.length ? args.subagent_type : undefined;
    const resumeAgentId = args.resume?.trim();

    if (
      resumeAgentId !== undefined &&
      resumeAgentId.length > 0 &&
      requestedProfileName !== undefined
    ) {
      return { output: RESUME_WITH_TYPE_UNAVAILABLE, isError: true };
    }

    const profileNameForDisplay =
      resumeAgentId !== undefined && resumeAgentId.length > 0
        ? this.resumeProfileName(resumeAgentId) ?? RESUMED_LABEL
        : requestedProfileName ?? DEFAULT_PROFILE_NAME;
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

  private resumeProfileName(agentId: string): string | undefined {
    const target = this.lifecycle.getHandle(agentId);
    if (target === undefined) return undefined;
    return target.accessor.get(IAgentProfileService).data().profileName;
  }

  private async launch(
    args: AgentToolInput,
    toolCallId: string,
    controller: AbortController,
  ): Promise<SubagentHandle> {
    const requester = this.lifecycle.getHandle(this.callerAgentId);
    if (requester === undefined) {
      throw new Error(`Caller agent "${this.callerAgentId}" does not exist`);
    }

    const resumeAgentId = args.resume?.trim();
    const isResume = resumeAgentId !== undefined && resumeAgentId.length > 0;

    let agentId: string;
    let profileName: string;
    let promptText = args.prompt;
    if (isResume) {
      const target = this.lifecycle.getHandle(resumeAgentId);
      if (target === undefined) {
        throw new Error(`Agent instance "${resumeAgentId}" does not exist`);
      }
      await this.ensureOwnedIdleSubagent(resumeAgentId, target);
      this.realignChildModel(target);
      agentId = target.id;
      profileName =
        target.accessor.get(IAgentProfileService).data().profileName ?? RESUMED_LABEL;
    } else {
      const requestedProfileName = args.subagent_type?.length
        ? args.subagent_type
        : DEFAULT_PROFILE_NAME;
      const profile = this.catalog.get(requestedProfileName);
      if (profile === undefined) {
        throw new Error(`Unknown agent type: "${requestedProfileName}"`);
      }
      const own = this.profile.data();
      if (own.modelAlias === undefined) {
        throw new Error('Caller agent has no model bound');
      }
      const created = await this.lifecycle.create({
        binding: {
          profile: profile.name,
          model: own.modelAlias,
          thinking: own.thinkingLevel,
          cwd: own.cwd,
        },
        permissionMode: this.permissionMode.mode,
        labels: subagentLabels(this.callerAgentId),
      });
      created.accessor
        .get(IAgentUserToolService)
        .inheritUserTools(requester.accessor.get(IAgentUserToolService));
      agentId = created.id;
      profileName = profile.name;
      promptText = await applyProfilePromptPrefix(profile, args.prompt, {
        cwd: this.workspace.workDir,
        runner: this.processRunner,
        log: this.log,
      });
    }

    const runInBackground = args.run_in_background === true;
    emitAgentRunSpawned(requester, agentId, {
      profileName,
      parentToolCallId: toolCallId,
      description: args.description,
      runInBackground,
    });

    const run = await this.lifecycle.run(
      agentId,
      { kind: 'prompt', prompt: promptText },
      { signal: controller.signal },
    );
    const mirrored = mirrorAgentRun(requester, run, {
      profileName,
      prompt: promptText,
      signal: controller.signal,
      cancel: (reason) => {
        controller.abort(reason);
      },
    });
    return {
      agentId,
      profileName,
      completion: mirrored.then((r) => ({ result: r.summary, usage: r.usage })),
    };
  }

  private async ensureOwnedIdleSubagent(
    agentId: string,
    target: IAgentScopeHandle,
  ): Promise<void> {
    const meta = (await this.sessionMetadata.read()).agents?.[agentId];
    if (!isSubagentMeta(meta)) {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (subagentParentAgentId(meta) !== this.callerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
    if (target.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error(`Agent instance "${agentId}" is already running and cannot run concurrently`);
    }
  }

  private realignChildModel(target: IAgentScopeHandle): void {
    const modelAlias = this.profile.data().modelAlias;
    if (modelAlias === undefined) {
      throw new Error('Caller agent has no model bound');
    }
    target.accessor.get(IAgentProfileService).update({ modelAlias });
  }

  private async execution(
    args: AgentToolInput,
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

      const allowBackground = this.canRunInBackground();
      if (runInBackground && !allowBackground) {
        return { output: BACKGROUND_AGENT_UNAVAILABLE, isError: true };
      }

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
          timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
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
            message === 'Too many detached tasks are already running.'
              ? 'Too many background tasks are already running.'
              : message,
          isError: true,
        };
      }

      if (runInBackground) {
        return {
          output: formatBackgroundAgentResult(taskId, handle, args.description, allowBackground),
        };
      }

      const release = await this.tasks.waitForForegroundRelease(taskId);
      if (release === 'detached') {
        return {
          output: formatBackgroundAgentResult(taskId, handle, args.description, allowBackground),
        };
      }
      return await this.formatForegroundResult(taskId, handle);
    } catch (error) {
      return { output: `subagent error: ${launchErrorMessage(error, signal)}`, isError: true };
    }
  }

  private async formatForegroundResult(
    taskId: string,
    handle: SubagentHandle,
  ): Promise<ExecutableToolResult> {
    const info = this.tasks.getTask(taskId);
    if (info?.status === 'completed') {
      return {
        output: formatForegroundAgentSuccess(handle, await this.tasks.readOutput(taskId)),
      };
    }
    const timedOut = info?.status === 'timed_out';
    const message = timedOut
      ? `Agent timed out after ${DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION}.`
      : info?.stopReason === 'Interrupted by user'
        ? USER_INTERRUPTED_SUBAGENT_MESSAGE
        : info?.stopReason !== undefined
          ? info.stopReason
          : 'The subagent was stopped before it finished.';
    return {
      output: formatForegroundAgentFailure(handle, message, timedOut),
      isError: true,
    };
  }
}

registerTool(AgentTool);


function buildProfileDescriptions(
  profiles: readonly AgentProfile[],
): string {
  return profiles
    .map((profile) => {
      const details = [profile.description, profile.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const header = details.length === 0 ? `- ${profile.name}` : `- ${profile.name}: ${details.join(' ')}`;
      if (profile.tools.length === 0) {
        return header;
      }
      return `${header}\n  Tools: ${profile.tools.join(', ')}`;
    })
    .join('\n');
}

function formatBackgroundAgentResult(
  taskId: string,
  handle: SubagentHandle,
  description: string,
  allowBackground: boolean,
): string {
  return [
    `task_id: ${taskId}`,
    'status: running',
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'automatic_notification: true',
    '',
    `description: ${description}`,
    '',
    allowBackground
      ? `next_step: The completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user. (If you have nothing to do until it finishes, run such tasks in the foreground next time.)`
      : 'next_step: The completion arrives automatically in a later turn.',
    `resume_hint: To continue or recover this same subagent later, call Agent(resume="${handle.agentId}", prompt="..."). The parameter is agent_id ("${handle.agentId}"), NOT task_id ("${taskId}") or source_id from a later <notification>. Recovery cases: a later <notification type="task.lost" | "task.failed" | "task.killed"> for this subagent — its conversation history is preserved across session restarts and resume will pick it up.`,
  ].join('\n');
}

function formatForegroundAgentSuccess(handle: SubagentHandle, result: string): string {
  return [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'status: completed',
    '',
    '[summary]',
    result,
  ].join('\n');
}

function formatForegroundAgentFailure(
  handle: SubagentHandle,
  message: string,
  timedOut: boolean,
): string {
  const lines = [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'status: failed',
    '',
    `subagent error: ${message}`,
  ];
  if (timedOut) {
    lines.push(
      `resume_hint: Continue with Agent(resume="${handle.agentId}", prompt="continue"). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`,
    );
  }
  return lines.join('\n');
}

function launchErrorMessage(error: unknown, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) return USER_INTERRUPTED_SUBAGENT_MESSAGE;
  if (isAbortError(error)) return 'The subagent was stopped before it finished.';
  return error instanceof Error ? error.message : String(error);
}
