/**
 * `agentLifecycle` domain (L6) — the `Agent` collaboration tool.
 *
 * Lets a parent Agent invoke a child Agent under a named profile from the App
 * `IAgentProfileCatalogService`. The tool is a thin adapter over three
 * primitives: `IAgentLifecycleService.spawn` (create the child scope inheriting
 * the parent's profile fields), `applyProfileToAgent` (overlay the named
 * profile's tool set / system-prompt / bookkeeping), and
 * `observeChildAgentTurn` (submit the prompt, mirror the child's turn
 * lifecycle onto the caller's record + external hooks, and distill the
 * summary). The tool owns only the LLM-facing surface: JSON schema + tool
 * description, approval rule, background-task registration (so the LLM can see
 * the child under TaskList/TaskOutput/TaskStop when `run_in_background=true`
 * or after detach), and the terminal text formatting.
 *
 * Registered via the module-level `registerTool(AgentTool)` at the bottom of
 * this file — the same "import = register" pattern used by every builtin tool.
 */

import { z } from 'zod';

import { isUserCancellation } from '#/_base/utils/abort';
import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import { matchesGlobRuleSubject } from '#/_base/tools/support/rule-match';
import {
  AgentBackgroundTask,
  IAgentBackgroundService,
  type RegisterBackgroundTaskOptions,
  type SubagentHandle,
} from '#/agent/background';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentRecordService } from '#/agent/record';
import { IAgentScopeContext } from '#/agent/scopeContext';
import { isAbortError } from '#/agent/loop/errors';
import type {
  BuiltinTool,
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/agent/tool';
import { ToolAccesses } from '#/agent/tool';
import { registerTool } from '#/agent/toolRegistry';
import {
  IAgentProfileCatalogService,
  type AgentProfileDefinition,
} from '#/app/agentProfileCatalog';
import { ILogService } from '#/app/log';
import { ITelemetryService } from '#/app/telemetry';
import { IExecContext } from '#/session/execContext';
import { ISessionProcessRunner } from '#/session/process';

import { IAgentLifecycleService } from '../agentLifecycle';
import { applyProfileToAgent } from '../applyProfileToAgent';
import { observeChildAgentTurn } from '../observeChildAgentTurn';

import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md?raw';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md?raw';
import AGENT_DESCRIPTION_BASE from './agent.md?raw';

const DEFAULT_PROFILE_NAME = 'coder';
const RESUMED_LABEL = 'subagent';
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION = '30 minutes';

// ── Input schema ────────────────────────────────────────────────────
//
// Wire arg name `subagent_type` is kept for compatibility (a rename would
// invalidate the tool_call args in existing session recordings). Internally
// the value is treated as a profile name from `IAgentProfileCatalogService`.
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
      .describe('Optional agent ID to resume instead of creating a new instance'),
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        'If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.',
      ),
  }),
);

export type AgentToolInput = z.infer<typeof AgentToolInputSchema>;

// ── Output schema (drift-guard only) ─────────────────────────────────

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

// ── AgentTool class ──────────────────────────────────────────────────

export class AgentTool implements BuiltinTool<AgentToolInput> {
  readonly name: string = 'Agent';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentToolInputSchema);

  private readonly callerAgentId: string;
  private readonly cwd: string;
  private readonly canRunInBackground: () => boolean;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @IAgentProfileCatalogService private readonly catalog: IAgentProfileCatalogService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentBackgroundService private readonly background: IAgentBackgroundService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentRecordService private readonly record: IAgentRecordService,
    @IExecContext execContext: IExecContext,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
  ) {
    this.callerAgentId = scopeContext.agentId;
    this.cwd = execContext.cwd;
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
    const child = this.lifecycle.getHandle(agentId);
    if (child === undefined) return undefined;
    return child.accessor.get(IAgentProfileService).data().profileName;
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

      const caller = this.lifecycle.getHandle(this.callerAgentId);
      if (caller === undefined) {
        return { output: `Caller agent "${this.callerAgentId}" is not registered`, isError: true };
      }

      // Resolve the target child (spawn a new one, or look up an existing agent id).
      let child;
      let profileName: string;
      let profile: AgentProfileDefinition | undefined;

      if (isResume) {
        child = this.lifecycle.getHandle(resumeAgentId!);
        if (child === undefined) {
          return { output: `Agent instance "${resumeAgentId}" does not exist`, isError: true };
        }
        profileName = child.accessor.get(IAgentProfileService).data().profileName ?? RESUMED_LABEL;
        profile = this.catalog.get(profileName);
      } else {
        profileName = requestedProfileName ?? DEFAULT_PROFILE_NAME;
        profile = this.catalog.get(profileName);
        if (profile === undefined) {
          return { output: `Unknown agent type: "${profileName}"`, isError: true };
        }
        try {
          child = await this.lifecycle.spawn(this.callerAgentId);
        } catch (error) {
          this.log?.warn('subagent spawn failed', {
            toolCallId,
            subagentType: profileName,
            error,
          });
          throw error;
        }
        applyProfileToAgent(child, profile);
      }

      // Announce the spawn on the caller's wire — this carries tool-call
      // provenance (parentToolCallId) that only the tool knows.
      this.record.signal({
        type: 'subagent.spawned',
        subagentId: child.id,
        subagentName: profileName,
        parentToolCallId: toolCallId,
        callerAgentId: this.callerAgentId,
        description: args.description,
        runInBackground,
      });
      this.telemetry?.track('subagent_created', {
        subagent_name: profileName,
        run_in_background: runInBackground,
      });

      const controller = new AbortController();
      const abortBeforeRegister = (): void => {
        controller.abort(signal.reason);
      };
      if (!runInBackground) {
        signal.addEventListener('abort', abortBeforeRegister, { once: true });
      }

      // Compose the prompt with any per-invocation prefix the profile owns
      // (e.g. explore's `<git-context>` block).
      const promptText = isResume
        ? args.prompt
        : await this.withProfilePrefix(profile!, args.prompt);

      const observed = observeChildAgentTurn(
        caller,
        child,
        { kind: 'prompt', prompt: promptText },
        {
          profileName,
          summaryPolicy: profile?.summaryPolicy,
          signal: controller.signal,
        },
      );
      if (observed === undefined) {
        signal.removeEventListener('abort', abortBeforeRegister);
        return { output: 'Subagent turn could not be started', isError: true };
      }

      const handle: SubagentHandle = {
        agentId: child.id,
        profileName,
        completion: observed.completion.then((r) => ({ result: r.summary, usage: r.usage })),
      };

      let taskId: string;
      try {
        const registerOptions: RegisterBackgroundTaskOptions = {
          detached: runInBackground,
          timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
          signal: runInBackground ? undefined : signal,
        };
        taskId = this.background.registerTask(
          new AgentBackgroundTask(handle, args.description, controller),
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
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }

      if (runInBackground) {
        return {
          output: formatBackgroundAgentResult(taskId, handle, args.description, allowBackground),
        };
      }

      const release = await this.background.waitForForegroundRelease(taskId);
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

  private async withProfilePrefix(
    profile: AgentProfileDefinition,
    prompt: string,
  ): Promise<string> {
    if (profile.promptPrefix === undefined) return prompt;
    try {
      const prefix = await profile.promptPrefix({
        cwd: this.cwd,
        runner: this.processRunner,
        log: this.log,
      });
      return prefix.length > 0 ? `${prefix}\n\n${prompt}` : prompt;
    } catch {
      return prompt;
    }
  }

  private async formatForegroundResult(
    taskId: string,
    handle: SubagentHandle,
  ): Promise<ExecutableToolResult> {
    const info = this.background.getTask(taskId);
    if (info?.status === 'completed') {
      return {
        output: formatForegroundAgentSuccess(handle, await this.background.readOutput(taskId)),
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

// ── formatting helpers ───────────────────────────────────────────────

function buildProfileDescriptions(
  profiles: readonly AgentProfileDefinition[],
): string {
  return profiles
    .map((profile) => {
      const details = [profile.description, profile.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const header = details.length === 0 ? `- ${profile.name}` : `- ${profile.name}: ${details.join(' ')}`;
      if (profile.activeToolNames === undefined || profile.activeToolNames.length === 0) {
        return header;
      }
      return `${header}\n  Tools: ${profile.activeToolNames.join(', ')}`;
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
      ? `next_step: The completion arrives automatically in a later turn — no polling needed. To peek at progress without blocking, call TaskOutput(task_id="${taskId}", block=false).`
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
