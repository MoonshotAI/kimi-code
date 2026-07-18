/**
 * `swarm` domain (L4) — `AgentSwarm` collaboration tool.
 *
 * Launches a batch of child agents (an ordinary Agent scope each) through the
 * session swarm coordinator and renders the per-subagent XML result. Reads
 * persisted swarm item labels through the Session-scoped coordinator so later
 * `resume_agent_ids` calls relabel resumed subagents like v1. Pure tool —
 * owns no scoped state.
 */

import { z } from 'zod';

import {
  ToolAccesses,
  type BuiltinTool,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelService } from '#/app/model/model';
import { IModelResolver } from '#/app/model/modelResolver';
import { ISessionSwarmService, type SessionSwarmTask } from '#/session/swarm/sessionSwarm';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { resolveSubagentTimeoutMs } from '#/session/subagent/configSection';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  filterResolvableSubagentModels,
  formatSubagentModelDirectory,
  isSelectableSubagentModelAlias,
  normalizeSubagentModelAlias,
  parametersWithSubagentModelSelection,
  subagentApprovalAgentName,
  SUBAGENT_MODEL_UNAVAILABLE_MESSAGE,
  subagentModelUnavailableError,
} from '#/tool/subagentModelSelection/modelDirectory';
import { SUBAGENT_MODEL_SELECTION_FLAG_ID } from '#/tool/subagentModelSelection/flag';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md?raw';

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
    subagent_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.',
      ),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Configured model alias used for every subagent in this swarm. Omit to inherit the caller model. See the available model directory in this tool description.',
      ),
    prompt_template: z
      .string()
      .trim()
      .min(1)
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
  .strict();

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

  private readonly callerAgentId: string;
  private readonly modelSelectionParameters: Record<string, unknown>;
  private readonly defaultParameters: Record<string, unknown>;

  constructor(
    @ISessionSwarmService private readonly swarmService: ISessionSwarmService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IConfigService private readonly config: IConfigService,
    @IModelService private readonly models: IModelService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelResolver private readonly modelResolver: IModelResolver,
    @IFlagService private readonly flags: IFlagService,
  ) {
    this.callerAgentId = scopeContext.agentId;
    this.modelSelectionParameters = toInputJsonSchema(AgentSwarmToolInputSchema);
    this.defaultParameters = parametersWithSubagentModelSelection(
      this.modelSelectionParameters,
      false,
    );
  }

  get parameters(): Record<string, unknown> {
    return this.modelSelectionEnabled()
      ? this.modelSelectionParameters
      : this.defaultParameters;
  }

  private modelSelectionEnabled(): boolean {
    return this.flags.enabled(SUBAGENT_MODEL_SELECTION_FLAG_ID);
  }

  get description(): string {
    if (!this.modelSelectionEnabled()) return AGENT_SWARM_DESCRIPTION;
    const directory = formatSubagentModelDirectory({
      models: filterResolvableSubagentModels(this.models.list(), (alias) =>
        this.modelResolver.resolve(alias),
      ),
      currentModel: this.profile.data().modelAlias,
    });
    return `${AGENT_SWARM_DESCRIPTION}\n\n${directory}`;
  }

  resolveExecution(args: AgentSwarmToolInput): ToolExecution {
    const modelSelectionEnabled = this.modelSelectionEnabled();
    if (args.model !== undefined && !modelSelectionEnabled) {
      return {
        output:
          'Subagent model selection is disabled. Enable the subagent-model-selection experimental feature to use model.',
        isError: true,
      };
    }
    let modelAlias = normalizeSubagentModelAlias(args.model);
    if (modelSelectionEnabled) modelAlias ??= this.profile.data().modelAlias;
    if (modelSelectionEnabled && modelAlias !== undefined) {
      try {
        if (args.model !== undefined) {
          const selectableModels = filterResolvableSubagentModels(
            this.models.list(),
            (alias) => this.modelResolver.resolve(alias),
          );
          if (!isSelectableSubagentModelAlias(selectableModels, modelAlias)) {
            throw new Error('Requested model alias is not in the exposed directory');
          }
        }
        this.modelResolver.resolve(modelAlias);
      } catch {
        return { output: SUBAGENT_MODEL_UNAVAILABLE_MESSAGE, isError: true };
      }
    }
    const agentCount = (args.items?.length ?? 0) + Object.keys(args.resume_agent_ids ?? {}).length;
    const agentName = subagentApprovalAgentName(
      `swarm (${agentCount} subagents)`,
      modelAlias,
    );
    return {
      accesses: ToolAccesses.all(),
      description: `Launching agent swarm: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: agentName,
        prompt: args.description,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx, modelSelectionEnabled, modelAlias),
    };
  }

  private async execution(
    args: AgentSwarmToolInput,
    context: ExecutableToolContext,
    modelSelectionEnabled: boolean,
    approvedModelAlias?: string,
  ): Promise<ExecutableToolResult> {
    try {
      if (args.model !== undefined && !modelSelectionEnabled) {
        throw new Error(
          'Subagent model selection is disabled. Enable the subagent-model-selection experimental feature to use model.',
        );
      }
      const result = await this.runSwarm(
        args,
        context.signal,
        context.toolCallId,
        modelSelectionEnabled ? approvedModelAlias : undefined,
      );
      return {
        output: result,
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async runSwarm(
    args: AgentSwarmToolInput,
    signal: AbortSignal,
    toolCallId: string,
    approvedModelAlias?: string,
  ): Promise<string> {
    const profileName = normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
    const timeoutMs = resolveSubagentTimeoutMs(this.config);
    const modelAlias = approvedModelAlias ?? this.profile.data().modelAlias;
    if (modelAlias === undefined) {
      throw new Error('Caller agent has no model bound');
    }
    try {
      this.modelResolver.resolve(modelAlias);
    } catch (error) {
      throw subagentModelUnavailableError(error);
    }
    const specs = await createAgentSwarmSpecs(args, (agentId) =>
      this.swarmService.getSwarmItem({ callerAgentId: this.callerAgentId, agentId }),
    );
    const tasks: SessionSwarmTask<AgentSwarmSpec>[] = specs.map((spec) => {
      const descriptionName = spec.kind === 'resume' ? 'resume' : profileName;
      const common = {
        data: spec,
        profileName: spec.kind === 'resume' ? 'subagent' : profileName,
        parentToolCallId: toolCallId,
        prompt: spec.prompt,
        description: childDescription(args.description, spec.index, descriptionName),
        modelAlias,
        swarmIndex: spec.index,
        runInBackground: false,
        swarmItem: spec.item,
        signal,
        timeout: timeoutMs,
      };
      if (spec.kind === 'resume') {
        return {
          ...common,
          kind: 'resume' as const,
          resumeAgentId: spec.agentId,
        };
      }
      return {
        ...common,
        kind: 'spawn' as const,
      };
    });
    const results = await this.swarmService.run({
      callerAgentId: this.callerAgentId,
      tasks,
      onValidated: () => {
        signal.throwIfAborted();
        this.swarmMode.enter('tool');
      },
    });
    return renderSwarmResults(
      results.map(({ task, ...result }) => ({ spec: task.data as AgentSwarmSpec, ...result })),
    );
  }
}

registerTool(AgentSwarmTool);

async function createAgentSwarmSpecs(
  args: AgentSwarmToolInput,
  getResumeItem: (agentId: string) => Promise<string | undefined>,
): Promise<AgentSwarmSpec[]> {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  const items = (args.items ?? []).map((item) => item.trim());
  const itemCount = items.length;
  const resumeCount = resumeEntries.length;
  const totalCount = resumeCount + itemCount;
  if (!hasMinimumAgentSwarmInputs(itemCount, resumeCount)) {
    throw new Error('AgentSwarm requires at least 2 items unless resume_agent_ids is provided.');
  }
  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error(`AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`);
  }
  const promptTemplate = normalizeOptionalString(args.prompt_template);
  if (items.length > 0 && promptTemplate === undefined) {
    throw new Error('prompt_template is required when items are provided.');
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error(
      `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
    );
  }

  const seenPrompts = new Map<string, number>();
  const specs: AgentSwarmSpec[] = [];
  for (const entry of resumeEntries) {
    specs.push({
      kind: 'resume',
      index: specs.length + 1,
      agentId: entry.agentId,
      item: await getResumeItem(entry.agentId),
      prompt: entry.prompt,
    });
  }
  if (items.length > 0) {
    const itemPromptTemplate = promptTemplate!;
    items.forEach((item, index) => {
      const prompt = itemPromptTemplate.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
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

function hasMinimumAgentSwarmInputs(itemCount: number, resumeCount: number): boolean {
  return resumeCount > 0 || itemCount >= 2;
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
      `<subagent${mode}${agentId}${item}${state} outcome="${result.status}">${body}</subagent>`,
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
