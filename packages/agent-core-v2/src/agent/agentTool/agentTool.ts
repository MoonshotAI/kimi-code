/**
 * `agentTool` domain (L5) — `Agent` collaboration tool.
 *
 * Spawns a task subagent (an ordinary Agent scope) through the `runChildAgent`
 * helpers and tracks its completion through the `background` service. Foreground
 * calls wait for the task to finish unless it is detached through the
 * background-task RPC. `ToolResult.content` is textual; the structured
 * `AgentToolOutputSchema` is only used for drift-guard and is not consumed at
 * runtime.
 */

import { z } from 'zod';

import type { BuiltinTool } from '#/agent/tool';
import type { ILogger } from '#/app/log';
import { collectGitContext } from '#/session/agentFs';
import type { ISessionProcessRunner } from '#/session/process';
import { ToolAccesses } from '#/agent/tool';
import { isAbortError } from '#/agent/loop/errors';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/agent/tool';
import { isUserCancellation } from '#/_base/utils/abort';
import {
  AgentBackgroundTask,
  type IAgentBackgroundService,
  type RegisterBackgroundTaskOptions,
} from '#/agent/background';
import type { IAgentProfileService } from '#/agent/profile';
import type { IAgentLifecycleService } from '#/session/agent-lifecycle';
import type { ISessionMetadata } from '#/session/session-metadata';
import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import { matchesGlobRuleSubject } from '#/_base/tools/support/rule-match';
import {
  getChildProfileName,
  resumeChildAgent,
  retryChildAgent,
  spawnChildAgent,
  type AgentToolRunOverride,
} from './runChildAgent';
import {
  DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  type SubagentHandle,
} from './types';
import { DEFAULT_AGENT_SUBAGENT_PROFILES } from './profiles';
import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md?raw';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md?raw';
import AGENT_DESCRIPTION_BASE from './agent.md?raw';

// ── AgentTool input ──────────────────────────────────────────────────

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
      normalized['subagent_type'] = 'coder';
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

// ── AgentTool output ─────────────────────────────────────────────────

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

export interface AgentToolSubagentProfile {
  readonly description?: string | undefined;
  readonly whenToUse?: string | undefined;
  readonly tools: readonly string[];
}

export type AgentToolSubagentMap = Readonly<Record<string, AgentToolSubagentProfile>>;

export interface AgentToolOptions {
  readonly lifecycle: IAgentLifecycleService;
  readonly callerAgentId: string;
  readonly metadata?: ISessionMetadata;
  readonly background: IAgentBackgroundService;
  readonly profile: IAgentProfileService;
  readonly cwd: string;
  readonly processRunner: ISessionProcessRunner;
  readonly log?: ILogger;
  readonly runOverride?: AgentToolRunOverride;
}

// ── AgentTool class ──────────────────────────────────────────────────

export class AgentTool implements BuiltinTool<AgentToolInput> {
  readonly name: string = 'Agent';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentToolInputSchema);

  private readonly lifecycle: IAgentLifecycleService;
  private readonly callerAgentId: string;
  private readonly metadata?: ISessionMetadata;
  private readonly background: IAgentBackgroundService;
  private readonly log?: ILogger;
  private readonly runOverride?: AgentToolRunOverride;
  private readonly typeLines: string;
  private readonly gitContext: { cwd: string; runner: ISessionProcessRunner };

  constructor(options: AgentToolOptions) {
    this.lifecycle = options.lifecycle;
    this.callerAgentId = options.callerAgentId;
    this.metadata = options.metadata;
    this.background = options.background;
    this.log = options.log;
    this.runOverride = options.runOverride;
    this.gitContext = { cwd: options.cwd, runner: options.processRunner };
    this.typeLines = buildSubagentDescriptions(DEFAULT_AGENT_SUBAGENT_PROFILES);
    this.canRunInBackground = () => {
      return (
        options.profile.isToolActive('TaskList') &&
        options.profile.isToolActive('TaskOutput') &&
        options.profile.isToolActive('TaskStop')
      );
    };
  }

  private readonly canRunInBackground: () => boolean;

  private get run(): AgentToolRunOverride {
    return (
      this.runOverride ?? {
        spawn: spawnChildAgent,
        resume: resumeChildAgent,
        retry: retryChildAgent,
        getProfileName: getChildProfileName,
      }
    );
  }

  get description(): string {
    const backgroundDescription = this.canRunInBackground()
      ? AGENT_BACKGROUND_DESCRIPTION
      : AGENT_BACKGROUND_DISABLED_DESCRIPTION;
    const baseDescription = `${AGENT_DESCRIPTION_BASE}\n\n${backgroundDescription}`;
    return this.typeLines
      ? `${baseDescription}\n\nAvailable agent types (pass via subagent_type):\n${this.typeLines}`
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

    let profileName = requestedProfileName ?? 'coder';
    if (resumeAgentId !== undefined && resumeAgentId.length > 0) {
      profileName =
        (await this.run.getProfileName({
          lifecycle: this.lifecycle,
          callerAgentId: this.callerAgentId,
          metadata: this.metadata,
          agentId: resumeAgentId,
        })) ?? 'subagent';
    }
    const prefix = args.run_in_background === true ? 'Launching background' : 'Launching';
    return {
      description: `${prefix} ${profileName} agent: ${args.description}`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'agent_call',
        agent_name: profileName,
        prompt: args.prompt,
        background: args.run_in_background,
      },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, profileName),
      execute: (ctx) => this.execution(args, ctx),
    };
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
      if (
        resumeAgentId !== undefined &&
        resumeAgentId.length > 0 &&
        requestedProfileName !== undefined
      ) {
        return {
          output: RESUME_WITH_TYPE_UNAVAILABLE,
          isError: true,
        };
      }

      const allowBackground = this.canRunInBackground();
      if (runInBackground && !allowBackground) {
        return {
          output: BACKGROUND_AGENT_UNAVAILABLE,
          isError: true,
        };
      }

      const controller = new AbortController();
      const abortBeforeRegister = (): void => {
        controller.abort(signal.reason);
      };
      if (!runInBackground) {
        signal.addEventListener('abort', abortBeforeRegister, { once: true });
      }

      const operation = resumeAgentId !== undefined && resumeAgentId.length > 0 ? 'resume' : 'spawn';
      const prompt =
        operation === 'spawn'
          ? await this.withGitContext(requestedProfileName ?? 'coder', args.prompt)
          : args.prompt;
      const runOptions = {
        parentToolCallId: toolCallId,
        prompt,
        description: args.description,
        runInBackground,
        signal: controller.signal,
      };
      let handle: SubagentHandle;
      try {
        handle =
          operation === 'resume'
            ? await this.run.resume({
                lifecycle: this.lifecycle,
                callerAgentId: this.callerAgentId,
                metadata: this.metadata,
                agentId: resumeAgentId!,
                ...runOptions,
              })
            : await this.run.spawn({
                lifecycle: this.lifecycle,
                callerAgentId: this.callerAgentId,
                metadata: this.metadata,
                profileName: requestedProfileName ?? 'coder',
                ...runOptions,
              });
      } catch (error) {
        signal.removeEventListener('abort', abortBeforeRegister);
        this.log?.warn('subagent launch failed', {
          toolCallId,
          runInBackground,
          operation,
          agentId: resumeAgentId,
          subagentType: operation === 'spawn' ? requestedProfileName ?? 'coder' : undefined,
          error,
        });
        throw error;
      }

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

  private async withGitContext(profileName: string, prompt: string): Promise<string> {
    if (profileName !== 'explore') return prompt;
    try {
      const context = await collectGitContext(this.gitContext.runner, this.gitContext.cwd, this.log);
      return context.length > 0 ? `${context}\n\n${prompt}` : prompt;
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

const USER_INTERRUPTED_SUBAGENT_MESSAGE =
  "The user manually interrupted this subagent (and any sibling agents launched alongside it). This was a deliberate user action, not a system error, a timeout, or a capacity/concurrency limit. Do not retry automatically or speculate about why it failed — wait for the user's next instruction.";

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

function buildSubagentDescriptions(subagents: AgentToolSubagentMap): string {
  return Object.entries(subagents)
    .map(([name, subagent]) => {
      const details = [subagent.description, subagent.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const header = details.length === 0 ? `- ${name}` : `- ${name}: ${details.join(' ')}`;
      if (subagent.tools.length === 0) return header;
      return `${header}\n  Tools: ${subagent.tools.join(', ')}`;
    })
    .join('\n');
}
