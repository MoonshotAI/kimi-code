import { z } from 'zod';

import type { SwarmMode } from '../../../agent/swarm';
import type { BuiltinTool } from '../../../agent/tool';
import type {
  QueuedSubagentRunResult,
  QueuedSubagentTask,
  SessionSubagentHost,
} from '../../../session/subagent-host';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md';

const DEFAULT_SUBAGENT_TYPE = 'coder';
const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
const MAX_AGENT_SWARM_SUBAGENTS = 128;

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
      .min(60)
      .max(3600)
      .optional()
      .describe(
        'Timeout in seconds for each subagent. Set a generous value so every child agent has enough time to complete its full assigned task.',
      ),
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
      .optional()
      .describe(
        `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
      ),
    items: z
      .array(z.string().trim().min(1))
      .max(MAX_AGENT_SWARM_SUBAGENTS)
      .optional()
      .describe(
        `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
      ),
    resume_agent_ids: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .optional()
      .describe(
        'Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.',
      ),
  })
  .strict()
  .superRefine((args, ctx) => {
    const itemCount = args.items?.length ?? 0;
    const resumeCount = Object.keys(args.resume_agent_ids ?? {}).length;
    const totalCount = itemCount + resumeCount;
    if (itemCount > 0 && args.prompt_template === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['prompt_template'],
        message: 'prompt_template is required when items are provided.',
      });
    }
    if (totalCount < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'AgentSwarm requires at least 2 total subagents.',
      });
    }
    if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: `AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`,
      });
    }
  });

export type AgentSwarmToolInput = z.infer<typeof AgentSwarmToolInputSchema>;

interface AgentSwarmSpawnSpec {
  readonly kind: 'spawn';
  readonly index: number;
  readonly item: string;
  readonly prompt: string;
}

interface AgentSwarmResumeSpec {
  readonly kind: 'resume';
  readonly index: number;
  readonly agentId: string;
  readonly item?: string;
  readonly prompt: string;
}

type AgentSwarmSpec = AgentSwarmSpawnSpec | AgentSwarmResumeSpec;

interface SwarmRunResult {
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly error?: string;
}

export class AgentSwarmTool implements BuiltinTool<AgentSwarmToolInput> {
  readonly name = 'AgentSwarm' as const;
  readonly description = AGENT_SWARM_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentSwarmToolInputSchema);

  constructor(
    private readonly subagentHost: SessionSubagentHost,
    private readonly swarmMode: SwarmMode,
  ) {}

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
      this.swarmMode.enter('implicit');
      const specs = createAgentSwarmSpecs(args);
      const result = await this.runSwarm(args, specs, context.signal, context.toolCallId);
      return {
        output: result,
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
    const profileName = normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
    const specsWithPersistedItems = specs.map((spec): AgentSwarmSpec => {
      if (spec.kind === 'spawn') return spec;
      return {
        ...spec,
        item: this.subagentHost.getSwarmItem(spec.agentId),
      };
    });
    const tasks = specsWithPersistedItems.map((spec): QueuedSubagentTask<AgentSwarmSpec> => {
      const resumeAgentId = spec.kind === 'resume' ? spec.agentId : undefined;
      return {
        data: spec,
        profileName: spec.kind === 'resume' ? 'subagent' : profileName,
        parentToolCallId: toolCallId,
        prompt: spec.prompt,
        description: childDescription(
          args.description,
          spec.index,
          spec.kind === 'resume' ? 'resume' : profileName,
        ),
        swarmItem: spec.item,
        runInBackground: false,
        resumeAgentId,
      };
    });
    const results = await this.subagentHost.runQueued(tasks, {
      signal,
      timeoutMs: args.timeout === undefined ? undefined : args.timeout * 1000,
    });
    return renderSwarmResults(results.map(toSwarmRunResult));
  }
}

function createAgentSwarmSpecs(args: AgentSwarmToolInput): AgentSwarmSpec[] {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(([agentId, prompt]) => {
    return {
      agentId: agentId.trim(),
      prompt: prompt.trim(),
    };
  });
  const items = (args.items ?? []).map((item) => item.trim());
  const totalCount = resumeEntries.length + items.length;
  if (totalCount < 2) {
    throw new Error('AgentSwarm requires at least 2 total subagents.');
  }
  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error(
      `AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`,
    );
  }
  const invalidResume = resumeEntries.find(
    (entry) => entry.agentId.length === 0 || entry.prompt.length === 0,
  );
  if (invalidResume !== undefined) {
    throw new Error('AgentSwarm resume_agent_ids must map non-empty agent ids to non-empty prompts.');
  }
  const invalidItem = items.find((item) => item.length === 0);
  if (invalidItem !== undefined) {
    throw new Error('AgentSwarm items must be non-empty strings.');
  }
  const promptTemplate = normalizeOptionalString(args.prompt_template);
  if (items.length > 0 && promptTemplate === undefined) {
    throw new Error('AgentSwarm prompt_template is required when items are provided.');
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error(`AgentSwarm prompt_template must include ${PROMPT_TEMPLATE_PLACEHOLDER}.`);
  }

  const seenPrompts = new Map<string, number>();
  const specs: AgentSwarmSpec[] = [];
  for (const entry of resumeEntries) {
    specs.push({
      kind: 'resume',
      index: specs.length + 1,
      agentId: entry.agentId,
      prompt: entry.prompt,
    });
  }
  if (items.length > 0) {
    if (promptTemplate === undefined) {
      throw new Error('AgentSwarm prompt_template is required when items are provided.');
    }
    items.forEach((item, index) => {
      const prompt = promptTemplate.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error(
          `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. AgentSwarm requires distinct subagents.`,
        );
      }
      seenPrompts.set(prompt, index + 1);
      specs.push({
        kind: 'spawn',
        index: specs.length + 1,
        item,
        prompt,
      });
    });
  }
  return specs;
}

function childDescription(swarmDescription: string, index: number, profileName: string): string {
  return `${swarmDescription} #${String(index)} (${profileName})`;
}

function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const shouldRenderResumeHint =
    results.some((result) => result.status !== 'completed') &&
    results.some((result) => result.agentId !== undefined);
  const lines = [
    '<agent_swarm_result>',
    `<summary>${renderSwarmSummary(completed, failed, aborted)}</summary>`,
  ];

  if (shouldRenderResumeHint) {
    lines.push(
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
    );
  }

  for (const result of results) {
    const agentId = result.agentId === undefined ? '' : ` agent_id="${result.agentId}"`;
    const mode = result.spec.kind === 'resume' ? ' mode="resume"' : '';
    const item = result.spec.item === undefined ? '' : ` item="${escapeXmlAttribute(result.spec.item)}"`;
    const state = result.state === undefined ? '' : ` state="${result.state}"`;
    const body = result.status === 'completed' ? (result.result ?? '') : (result.error ?? 'unknown error');
    lines.push(
      `<subagent index="${String(result.spec.index)}"${mode}${agentId}${item}${state} outcome="${result.status}">${body}</subagent>`,
    );
  }

  lines.push('</agent_swarm_result>');
  return lines.join('\n');
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function renderSwarmSummary(completed: number, failed: number, aborted = 0): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  return parts.join(', ');
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function toSwarmRunResult(
  result: QueuedSubagentRunResult<AgentSwarmSpec>,
): SwarmRunResult {
  return {
    spec: result.task.data,
    agentId: result.agentId,
    status: result.status,
    state: result.state,
    result: result.result,
    error: result.error,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
