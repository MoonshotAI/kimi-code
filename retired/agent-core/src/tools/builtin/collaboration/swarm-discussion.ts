import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { SwarmMode } from '../../../agent/swarm';
import {
  SwarmDiscussionCoordinator,
  type DiscussionObserver,
} from '../../../agent/discussion/coordinator';
import { StructuredDebateCoordinator } from '../../../agent/discussion/debate-coordinator';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import type { SessionSubagentHost } from '../../../session/subagent-host';
import { toInputJsonSchema } from '../../support/input-schema';
import SWARM_DISCUSSION_DESCRIPTION from './swarm-discussion.md?raw';

const DebateParticipantSchema = z.object({
  profileName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .default('coder')
    .describe('Agent profile name, e.g. "coder" or "explore".'),
  roleDescription: z
    .string()
    .trim()
    .min(1)
    .describe('Role description for this participant.'),
  assignedStance: z
    .string()
    .trim()
    .optional()
    .describe('Optional: assign a specific stance to this participant (e.g. "argue for migration").'),
});

const SwarmDiscussionToolInputSchema = z.object({
  mode: z
    .enum(['discussion', 'debate'])
    .optional()
    .default('discussion')
    .describe('"discussion" for open roundtable, "debate" for structured debate with opening/free-debate/closing phases.'),
  topic: z.string().trim().min(1).describe('The topic or question to discuss/debate.'),
  participants: z
    .array(DebateParticipantSchema)
    .min(2)
    .max(10)
    .describe('The participants (2-10).'),
  maxRounds: z
    .number()
    .int()
    .positive()
    .optional()
    .default(3)
    .describe('For discussion: max rounds. For debate: max free-debate rounds.'),
  summaryPrompt: z
    .string()
    .trim()
    .optional()
    .describe('Optional prompt to generate a final summary or consensus after the discussion/debate.'),
  enableVoting: z
    .boolean()
    .optional()
    .default(false)
    .describe('For debate only: whether to include a voting phase on key points.'),
});

export type SwarmDiscussionToolInput = z.infer<typeof SwarmDiscussionToolInputSchema>;

export class SwarmDiscussionTool implements BuiltinTool<SwarmDiscussionToolInput> {
  readonly name = 'SwarmDiscussion' as const;
  readonly description = SWARM_DISCUSSION_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SwarmDiscussionToolInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly swarmMode: SwarmMode,
  ) {}

  resolveExecution(args: SwarmDiscussionToolInput): ToolExecution {
    const participantCount = args.participants.length;
    const mode = args.mode ?? 'discussion';
    return {
      accesses: ToolAccesses.all(),
      description: `${mode === 'debate' ? 'Structured debate' : 'Roundtable discussion'}: ${args.topic}`,
      display: {
        kind: 'agent_call',
        agent_name: `${mode} (${String(participantCount)} participants)`,
        prompt: args.topic,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: SwarmDiscussionToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      this.swarmMode.enter('tool');

      if (args.mode === 'debate') {
        return await this.runDebate(args, context);
      }
      return await this.runDiscussion(args, context);
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async runDiscussion(
    args: SwarmDiscussionToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const coordinator = new SwarmDiscussionCoordinator(this.subagentHost);
    const result = await coordinator.discuss(
      {
        topic: args.topic,
        participants: args.participants.map((p) => ({
          profileName: p.profileName ?? 'coder',
          roleDescription: p.roleDescription,
          turnsPerRound: 1,
        })),
        maxRounds: args.maxRounds ?? 3,
        summaryPrompt: args.summaryPrompt,
      },
      context.signal,
    );

    return {
      output: formatDiscussionResult(result),
    };
  }

  private async runDebate(
    args: SwarmDiscussionToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const coordinator = new StructuredDebateCoordinator(this.subagentHost);
    const result = await coordinator.debate(
      {
        topic: args.topic,
        participants: args.participants.map((p) => ({
          profileName: p.profileName ?? 'coder',
          roleDescription: p.roleDescription,
          assignedStance: p.assignedStance,
        })),
        maxDebateRounds: args.maxRounds ?? 2,
        consensusPrompt: args.summaryPrompt,
        enableVoting: args.enableVoting ?? false,
      },
      context.signal,
    );

    return {
      output: formatDebateResult(result),
    };
  }
}

function formatDiscussionResult(
  result: import('../../../agent/discussion/coordinator').DiscussionResult,
): string {
  const lines: string[] = [];

  lines.push('<discussion_result>');

  const statusText =
    result.endedBy === 'max_rounds' ? 'completed' : result.endedBy;
  lines.push(
    `<summary>rounds: ${String(result.roundsCompleted)}, speeches: ${String(result.transcript.length)}, status: ${statusText}</summary>`,
  );

  lines.push('<transcript>');
  for (const entry of result.transcript) {
    lines.push(`[${entry.speaker}] ${entry.content}`);
    lines.push('');
  }
  lines.push('</transcript>');

  if (result.summary.length > 0) {
    lines.push('<final_summary>');
    lines.push(result.summary);
    lines.push('</final_summary>');
  }

  lines.push('</discussion_result>');

  return lines.join('\n');
}

function formatDebateResult(
  result: import('../../../agent/discussion/debate-coordinator').DebateResult,
): string {
  const lines: string[] = [];

  lines.push('<debate_result>');

  const statusText = result.endedBy;
  lines.push(
    `<summary>speeches: ${String(result.transcript.length)}, phases: ${String(result.phases.length)}, cross_refs: ${String(result.crossReferencesCount)}, position_changes: ${String(result.positionChanges)}, status: ${statusText}</summary>`,
  );

  // Phase breakdown
  lines.push('<phases>');
  for (const phase of result.phases) {
    lines.push(`  <phase name="${phase.phase}" speeches="${String(phase.entryCount)}" />`);
  }
  lines.push('</phases>');

  // Full transcript with phase markers
  lines.push('<transcript>');
  for (const entry of result.transcript) {
    lines.push(`[${entry.speaker}] ${entry.content}`);
    lines.push('');
  }
  lines.push('</transcript>');

  if (result.consensus.length > 0) {
    lines.push('<consensus>');
    lines.push(result.consensus);
    lines.push('</consensus>');
  }

  if (result.votingResult.length > 0) {
    lines.push('<voting_result>');
    lines.push(result.votingResult);
    lines.push('</voting_result>');
  }

  lines.push('</debate_result>');

  return lines.join('\n');
}