import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { SessionSubagentHost, SubagentHandle } from '../../../session/subagent-host';
import {
  createDeadlineAbortSignal,
  isUserCancellation,
  type DeadlineAbortSignal,
} from '../../../utils/abort';
import { isAbortError } from '../../../loop/errors';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md';

const MAX_SWARM_AGENTS = 50;
const DEFAULT_SUBAGENT_TYPE = 'coder';
const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';

export const AgentSwarmToolInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .describe('Short description for the whole swarm.'),
    timeout: z
      .number()
      .int()
      .min(30)
      .max(3600)
      .optional()
      .describe('Timeout in seconds for each subagent.'),
    subagent_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Subagent type used for every spawned subagent. Defaults to coder when omitted.',
      ),
    prompt_template: z
      .string()
      .trim()
      .min(1)
      .refine((value) => value.includes(PROMPT_TEMPLATE_PLACEHOLDER), {
        message: `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
      })
      .describe(
        `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
      ),
    items: z
      .array(z.string().trim().min(1))
      .min(2)
      .max(MAX_SWARM_AGENTS)
      .describe(
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one subagent.`,
      ),
  })
  .strict();

export type AgentSwarmToolInput = z.infer<typeof AgentSwarmToolInputSchema>;

interface AgentSwarmSpec {
  readonly index: number;
  readonly item: string;
  readonly prompt: string;
}

interface SwarmRunResult {
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  readonly profileName: string;
  readonly description: string;
  readonly status: 'completed' | 'failed';
  readonly result?: string;
  readonly error?: string;
}

export class AgentSwarmTool implements BuiltinTool<AgentSwarmToolInput> {
  readonly name = 'AgentSwarm' as const;
  readonly description = AGENT_SWARM_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentSwarmToolInputSchema);

  constructor(private readonly subagentHost: SessionSubagentHost) {}

  resolveExecution(args: AgentSwarmToolInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Launching agent swarm: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: 'swarm',
        prompt: args.description,
      },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'swarm'),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentSwarmToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const specs = createAgentSwarmSpecs(args);
      const result = await this.runSwarm(args, specs, context.signal, context.toolCallId);
      return {
        output: result,
        isError: swarmResultHasFailures(result) ? true : undefined,
      };
    } catch (error) {
      return {
        output: errorMessage(error),
        isError: true,
      };
    }
  }

  private async runSwarm(
    args: AgentSwarmToolInput,
    specs: readonly AgentSwarmSpec[],
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<string> {
    let foregroundDeadline: DeadlineAbortSignal | undefined;
    try {
      foregroundDeadline =
        args.timeout !== undefined
          ? createDeadlineAbortSignal(signal, args.timeout * 1000)
          : undefined;
      const runSignal = foregroundDeadline?.signal ?? signal;
      const results = await Promise.all(
        specs.map((spec) =>
          this.runOne(
            args,
            spec,
            runSignal,
            toolCallId,
            () => foregroundDeadline?.timedOut() === true,
          ),
        ),
      );
      return renderSwarmResults(args, results);
    } finally {
      foregroundDeadline?.clear();
    }
  }

  private async runOne(
    args: AgentSwarmToolInput,
    spec: AgentSwarmSpec,
    signal: AbortSignal,
    toolCallId: string,
    timedOut: () => boolean,
  ): Promise<SwarmRunResult> {
    const profileName = args.subagent_type ?? DEFAULT_SUBAGENT_TYPE;
    const description = childDescription(args.description, spec.index, profileName);
    let handle: SubagentHandle | undefined;
    try {
      signal.throwIfAborted();
      handle = await this.subagentHost.spawn(profileName, {
        parentToolCallId: toolCallId,
        prompt: spec.prompt,
        description,
        runInBackground: false,
        signal,
      });
      const completion = await handle.completion;
      return {
        spec,
        agentId: handle.agentId,
        profileName: handle.profileName,
        description,
        status: 'completed',
        result: completion.result,
      };
    } catch (error) {
      return {
        spec,
        agentId: handle?.agentId,
        profileName: handle?.profileName ?? profileName,
        description,
        status: 'failed',
        error: formatSubagentError(error, signal, timedOut, args.timeout),
      };
    }
  }
}

function createAgentSwarmSpecs(args: AgentSwarmToolInput): AgentSwarmSpec[] {
  if (!args.prompt_template.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error(`AgentSwarm prompt_template must include ${PROMPT_TEMPLATE_PLACEHOLDER}.`);
  }

  const seenPrompts = new Map<string, number>();
  return args.items.map((item, index) => {
    const prompt = args.prompt_template.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
    const previousIndex = seenPrompts.get(prompt);
    if (previousIndex !== undefined) {
      throw new Error(
        `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. AgentSwarm requires distinct subagents.`,
      );
    }
    seenPrompts.set(prompt, index + 1);
    return {
      index: index + 1,
      item,
      prompt,
    };
  });
}

function childDescription(swarmDescription: string, index: number, profileName: string): string {
  return `${swarmDescription} #${String(index)} (${profileName})`;
}

function renderSwarmResults(
  args: AgentSwarmToolInput,
  results: readonly SwarmRunResult[],
): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.length - completed;
  const lines = [
    `agent_swarm: ${failed > 0 ? 'failed' : 'completed'}`,
    `description: ${args.description}`,
    `subagent_type: ${args.subagent_type ?? DEFAULT_SUBAGENT_TYPE}`,
    `placeholder: ${PROMPT_TEMPLATE_PLACEHOLDER}`,
    `items: ${String(results.length)}`,
    `completed: ${String(completed)}`,
    `failed: ${String(failed)}`,
  ];

  for (const result of results) {
    lines.push(
      '',
      `[agent ${String(result.spec.index)}]`,
      ...(result.agentId === undefined ? [] : [`agent_id: ${result.agentId}`]),
      `item: ${JSON.stringify(result.spec.item)}`,
      `actual_subagent_type: ${result.profileName}`,
      `status: ${result.status}`,
      `description: ${result.description}`,
      '',
    );
    if (result.status === 'completed') {
      lines.push('[summary]', result.result ?? '');
    } else {
      lines.push(`subagent error: ${result.error ?? 'unknown error'}`);
    }
  }

  return lines.join('\n');
}

function swarmResultHasFailures(result: string): boolean {
  return result.startsWith('agent_swarm: failed\n');
}

function formatSubagentError(
  error: unknown,
  signal: AbortSignal,
  timedOut: () => boolean,
  timeout: number | undefined,
): string {
  if (timedOut() && timeout !== undefined) {
    return `AgentSwarm timed out after ${String(timeout)}s.`;
  }
  if (isUserCancellation(signal.reason)) {
    return 'The user manually interrupted this subagent swarm.';
  }
  if (isAbortError(error)) {
    return 'The subagent was stopped before it finished.';
  }
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
