/**
 * AgentTool — collaboration tool for spawning task subagents.
 *
 * Unlike the built-in tools (Read/Write/Edit/Bash/Grep/Glob), this is a
 * "collaboration tool". It uses `SessionSubagentHost` (injected via the
 * constructor rather than through the Runtime) to create in-process subagent
 * loop instances.
 *
 * Two modes:
 *   - **Foreground** (default): blocks the parent turn, `await handle.completion`
 *   - **Background**: returns the agent id immediately; the result is delivered
 *     via a notification.
 *
 * `ToolResult.content` is textual; the structured output exposed by
 * `AgentToolOutputSchema` is only used for drift-guard and is not consumed at
 * runtime.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { Logger } from '../../../logging';
import { ToolAccesses } from '../../../loop/tool-access';
import { isAbortError } from '../../../loop/errors';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { ResolvedAgentProfile } from '../../../profile';
import type { SessionSubagentHost, SubagentHandle } from '../../../session/subagent-host';
import {
  createDeadlineAbortSignal,
  isUserCancellation,
  type DeadlineAbortSignal,
} from '../../../utils/abort';
import { AgentBackgroundTask, type BackgroundManager } from '../../../agent/background';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md';
import AGENT_DESCRIPTION_BASE from './agent.md';

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
    timeout: z
      .number()
      .int()
      .min(30)
      .max(3600)
      .optional()
      .describe(
        'Timeout in seconds for the agent task (min 30s, max 3600s / 1hr). When omitted, a foreground task runs until completion with no timeout. The agent is stopped if it exceeds this limit.',
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

// ── AgentTool class ──────────────────────────────────────────────────

export class AgentTool implements BuiltinTool<AgentToolInput> {
  readonly name: string = 'Agent';
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentToolInputSchema);
  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly backgroundManager?: BackgroundManager | undefined,
    subagents?: ResolvedAgentProfile['subagents'] | undefined,
    options?: {
      log?: Logger;
    },
  ) {
    const log = options?.log;
    const typeLines = buildSubagentDescriptions(subagents);
    const baseDescription = `${AGENT_DESCRIPTION_BASE}\n\n${
      this.backgroundManager !== undefined ? AGENT_BACKGROUND_DESCRIPTION : AGENT_BACKGROUND_DISABLED_DESCRIPTION
    }`;
    this.description = typeLines
      ? `${baseDescription}\n\nAvailable agent types (pass via subagent_type):\n${typeLines}`
      : baseDescription;
    this.log = log;
  }

  private readonly log?: Logger;

  async resolveExecution(args: AgentToolInput): Promise<ToolExecution> {
    let profileName = args.subagent_type?.length ? args.subagent_type : 'coder';
    const resumeAgentId = args.resume?.trim();
    if (resumeAgentId !== undefined && resumeAgentId.length > 0) {
      profileName = (await this.subagentHost.getProfileName?.(resumeAgentId)) ?? 'subagent';
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
    {
    toolCallId,
    signal,
    }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    let foregroundDeadline: DeadlineAbortSignal | undefined;
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
          output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
          isError: true,
        };
      }

      if (runInBackground) {
        if (this.backgroundManager === undefined) {
          return {
            output: BACKGROUND_AGENT_UNAVAILABLE,
            isError: true,
          };
        }
      }
      const backgroundController = runInBackground ? new AbortController() : undefined;
      const timeoutMs = args.timeout === undefined ? undefined : args.timeout * 1000;
      foregroundDeadline =
        !runInBackground && timeoutMs !== undefined
          ? createDeadlineAbortSignal(signal, timeoutMs)
          : undefined;

      const options = {
        parentToolCallId: toolCallId,
        prompt: args.prompt,
        description: args.description,
        runInBackground,
        signal: backgroundController?.signal ?? foregroundDeadline?.signal ?? signal,
      };

      let handle: SubagentHandle;
      const operation = resumeAgentId !== undefined && resumeAgentId.length > 0 ? 'resume' : 'spawn';
      try {
        if (resumeAgentId !== undefined && resumeAgentId.length > 0) {
          handle = await this.subagentHost.resume(resumeAgentId, options);
        } else {
          const profileName = requestedProfileName ?? 'coder';
          handle = await this.subagentHost.spawn(profileName, options);
        }
      } catch (error) {
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

      if (runInBackground) {
        let taskId: string;
        try {
          taskId = this.backgroundManager!.registerTask(
            new AgentBackgroundTask(handle.completion, args.description, {
              timeoutMs: timeoutMs ?? this.subagentHost.backgroundTaskTimeoutMs,
              agentId: handle.agentId,
              subagentType: handle.profileName,
              abort: () => {
                backgroundController?.abort();
              },
            }),
          );
        } catch (error) {
          backgroundController?.abort();
          void handle.completion.catch(() => {});
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
        const lines = [
          `task_id: ${taskId}`,
          'status: running',
          `agent_id: ${handle.agentId}`,
          `actual_subagent_type: ${handle.profileName}`,
          'automatic_notification: true',
          '',
          `description: ${args.description}`,
          '',
          `next_step: The completion arrives automatically in a later turn — no polling needed. To peek at progress without blocking, call TaskOutput(task_id="${taskId}", block=false).`,
          `resume_hint: To continue or recover this same subagent later, call Agent(resume="${handle.agentId}", prompt="..."). The parameter is agent_id ("${handle.agentId}"), NOT task_id ("${taskId}") or source_id from a later <notification>. Recovery cases: a later <notification type="task.lost" | "task.failed" | "task.killed"> for this subagent — its conversation history is preserved across session restarts and resume will pick it up.`,
        ];
        return { output: lines.join('\n') };
      }

      try {
        const result = await handle.completion;
        const lines = [
          `agent_id: ${handle.agentId}`,
          `actual_subagent_type: ${handle.profileName}`,
          'status: completed',
          '',
          '[summary]',
          result.result,
        ];
        return { output: lines.join('\n') };
      } catch (error) {
        let message: string;
        if (foregroundDeadline?.timedOut() === true && args.timeout !== undefined) {
          message = `Agent timed out after ${args.timeout}s.`;
        } else if (isUserCancellation(signal.reason)) {
          message =
            'The user manually interrupted this subagent (and any sibling agents launched alongside it). This was a deliberate user action, not a system error, a timeout, or a capacity/concurrency limit. Do not retry automatically or speculate about why it failed — wait for the user\'s next instruction.';
        } else if (isAbortError(error)) {
          message = 'The subagent was stopped before it finished.';
        } else {
          message = error instanceof Error ? error.message : String(error);
        }
        const lines = [
          `agent_id: ${handle.agentId}`,
          `actual_subagent_type: ${handle.profileName}`,
          'status: failed',
          '',
          `subagent error: ${message}`,
        ];
        return { output: lines.join('\n'), isError: true };
      }
    } catch (error) {
      let message: string;
      if (foregroundDeadline?.timedOut() === true && args.timeout !== undefined) {
        message = `Agent timed out after ${args.timeout}s.`;
      } else if (isUserCancellation(signal.reason)) {
        message =
          'The user manually interrupted this subagent (and any sibling agents launched alongside it). This was a deliberate user action, not a system error, a timeout, or a capacity/concurrency limit. Do not retry automatically or speculate about why it failed — wait for the user\'s next instruction.';
      } else if (isAbortError(error)) {
        message = 'The subagent was stopped before it finished.';
      } else {
        message = error instanceof Error ? error.message : String(error);
      }
      return { output: `subagent error: ${message}`, isError: true };
    } finally {
      foregroundDeadline?.clear();
    }
  }
}

function buildSubagentDescriptions(subagents: ResolvedAgentProfile['subagents']): string {
  if (subagents === undefined) return '';
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
