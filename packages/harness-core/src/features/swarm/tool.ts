import {
  createUserMessage,
  type AgentCommands,
  type AgentHandle,
  type SessionCommands,
  type ToolDefinition,
  type ToolUpdate,
  type TurnOutcome,
} from '@moonshot-ai/agent-core';

import type { OsProcessPort } from '#/features/os/host/index';
import { DEFAULT_SUBAGENT_PROFILE_NAME, type ProfileCatalog } from '#/features/profiles/index';
import {
  classifyOutcome,
  createSubagentLauncher,
  forkIncompatibility,
  FORK_EXPERIMENTAL_UNAVAILABLE,
  FORK_WITH_RESUME_UNAVAILABLE,
  latestAssistantText,
  planSpawn,
  SUBAGENT_UPDATE_KEY,
  sumUsage,
  type SpawnModelEntry,
  type SpawnPlan,
  type SpawnRegistry,
} from '#/features/spawn/index';

import AGENT_SWARM_DESCRIPTION from './agent-swarm.md?raw';
import {
  AgentRunBatch,
  resolveSwarmMaxConcurrency,
  type AgentRunAttemptHandle,
  type AgentRunAttemptOptions,
  type AgentRunBatchLauncher,
  type SwarmTask,
} from './batch';
import { AGENT_SWARM_TOOL_NAME } from './guard';

export { AGENT_SWARM_TOOL_NAME };

export const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}';
export const MAX_AGENT_SWARM_SUBAGENTS = 128;

const RESUMED_PROFILE_FALLBACK = 'subagent';

export type SwarmItemRegistry = Map<string, { readonly callerAgentId: string; readonly item: string }>;

export interface AgentSwarmArgs {
  readonly description?: string;
  readonly subagent_type?: string;
  readonly prompt_template?: string;
  readonly items?: readonly string[];
  readonly fork?: boolean;
  readonly resume_agent_ids?: Readonly<Record<string, string>>;
  readonly model?: string;
}

export interface AgentSwarmSpawnSpec {
  readonly kind: 'spawn';
  readonly index: number;
  readonly item: string;
  readonly prompt: string;
}

export interface AgentSwarmResumeSpec {
  readonly kind: 'resume';
  readonly index: number;
  readonly agentId: string;
  readonly item?: string;
  readonly prompt: string;
}

export type AgentSwarmSpec = AgentSwarmSpawnSpec | AgentSwarmResumeSpec;

export interface AgentSwarmSpecResult {
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly stopReason?: string;
  readonly error?: string;
}

export interface AgentSwarmToolDeps {
  readonly catalog: ProfileCatalog;
  readonly models: readonly SpawnModelEntry[];
  readonly registry: SpawnRegistry;
  readonly session: SessionCommands;
  readonly agent: AgentCommands;
  readonly forkEnabled: () => boolean;
  readonly process?: OsProcessPort;
  readonly workDir: string;
  readonly swarmItems: SwarmItemRegistry;
  readonly timeoutMs: () => number;
}

export function createAgentSwarmTool(deps: AgentSwarmToolDeps): ToolDefinition {
  const { catalog, models, registry, session, agent, forkEnabled, swarmItems } = deps;
  const callerAgentId = agent.agentId;
  const launcher = createSubagentLauncher({
    catalog,
    models,
    registry,
    session,
    agent,
    process: deps.process,
    workDir: deps.workDir,
  });

  const getSwarmItem = (agentId: string): string | undefined => {
    const entry = swarmItems.get(agentId);
    return entry?.callerAgentId === callerAgentId ? entry.item : undefined;
  };

  const historyLength = (agentId: string): number =>
    session.stores.get(agentId)?.getState().history.length ?? 0;

  const resetRunning = (agentId: string): void => {
    const record = registry.get(agentId);
    if (record !== undefined) record.running = false;
  };

  const runSubagent = (
    target: AgentHandle,
    prompt: string,
    signal: AbortSignal,
    onReady?: () => void,
  ): Promise<TurnOutcome> =>
    target
      .run(createUserMessage(prompt), {
        meta: { origin: { kind: 'subagent' } },
        signal,
        onStarted: onReady,
        abortAsOutcome: true,
      })
      .then((settled) => settled.outcome);

  const observe = (
    agentId: string,
    profileName: string,
    run: Promise<TurnOutcome>,
    historyBefore: number,
    options: AgentRunAttemptOptions,
    batchAborted: () => boolean,
  ): AgentRunAttemptHandle => {
    const completion = run.then((outcome) => {
      const history = session.stores.get(agentId)?.getState().history;
      const produced = history?.slice(historyBefore) ?? [];
      const summary = latestAssistantText(produced);
      if (outcome.type === 'done' && summary.trim().length > 0) {
        const usage = sumUsage(produced);
        return { result: summary, usage };
      }
      if (outcome.type === 'aborted' && batchAborted()) {
        throw attemptError(outcome, classifyOutcome(outcome).message);
      }
      if (outcome.type === 'aborted') {
        const message = abortReasonMessage(outcome.reason);
        throw attemptError(outcome, message);
      }
      const failure = classifyOutcome(outcome);
      throw attemptError(outcome, failure.message);
    });
    return {
      agentId,
      profileName,
      completion: completion.finally(() => {
        resetRunning(agentId);
      }),
    };
  };

  const buildBatchLauncher = (
    batchAborted: () => boolean,
    onUpdate: ((update: ToolUpdate) => void) | undefined,
  ): AgentRunBatchLauncher => ({
    spawn: async (options) => {
      options.signal.throwIfAborted();
      const launched = await launcher.launchPlanned(options.plan, options.prompt);
      if (typeof launched === 'string') throw new Error(launched);
      if (options.swarmItem !== undefined) {
        swarmItems.set(launched.agentId, { callerAgentId, item: options.swarmItem });
      }
      onUpdate?.({ key: SUBAGENT_UPDATE_KEY, text: launched.agentId });
      return observe(
        launched.agentId,
        launched.profileName,
        runSubagent(launched.target, launched.promptText, options.signal, options.onReady),
        launched.historyBefore,
        options,
        batchAborted,
      );
    },
    resume: async (agentId, options) => {
      options.signal.throwIfAborted();
      const launched = await launcher.resume(agentId, options.prompt);
      if (typeof launched === 'string') throw new Error(launched);
      onUpdate?.({ key: SUBAGENT_UPDATE_KEY, text: agentId });
      return observe(
        agentId,
        launched.profileName,
        runSubagent(launched.target, launched.promptText, options.signal, options.onReady),
        launched.historyBefore,
        options,
        batchAborted,
      );
    },
    retry: async (agentId, options) => {
      options.signal.throwIfAborted();
      const target = session.get(agentId) ?? (await session.create({ agentId }));
      const record = registry.get(agentId);
      if (record?.running === true) {
        throw new Error(
          `Agent instance "${agentId}" is already running and cannot run concurrently.`,
        );
      }
      registry.set(agentId, {
        parentAgentId: record?.parentAgentId ?? callerAgentId,
        profileName: record?.profileName ?? RESUMED_PROFILE_FALLBACK,
        running: true,
      });
      const profileName = record?.profileName ?? RESUMED_PROFILE_FALLBACK;
      return observe(
        agentId,
        profileName,
        target
          .retry({
            signal: options.signal,
            onStarted: options.onReady,
            abortAsOutcome: true,
          })
          .then((settled) => settled.outcome),
        historyLength(agentId),
        options,
        batchAborted,
      );
    },
  });

  const runSwarm = async (
    args: AgentSwarmArgs,
    signal: AbortSignal,
    toolCallId: string,
    onUpdate: ((update: ToolUpdate) => void) | undefined,
  ): Promise<string> => {
    const fork = args.fork === true;
    if (fork && !forkEnabled()) {
      throw new Error(FORK_EXPERIMENTAL_UNAVAILABLE);
    }
    if (fork && Object.keys(args.resume_agent_ids ?? {}).length > 0) {
      throw new Error(FORK_WITH_RESUME_UNAVAILABLE);
    }
    let plan: Extract<SpawnPlan, { ok: true }> | undefined;
    if ((args.items?.length ?? 0) > 0) {
      if (fork) {
        const incompatible = forkIncompatibility(
          { subagent_type: args.subagent_type, model: args.model },
          {
            profileName: registry.get(callerAgentId)?.profileName,
            modelAlias: agent.model?.spec.name,
          },
        );
        if (incompatible !== undefined) {
          throw new Error(incompatible);
        }
      }
      const planned = planSpawn(
        {
          callerAgentId,
          callerProfileName: registry.get(callerAgentId)?.profileName,
          profileName: args.subagent_type,
          model: args.model,
          fork,
        },
        { catalog, models },
      );
      if (!planned.ok) throw new Error(planned.error);
      plan = planned;
    }
    const profileName = plan?.profileName ?? DEFAULT_SUBAGENT_PROFILE_NAME;
    const timeoutMs = deps.timeoutMs();
    const specs = createAgentSwarmSpecs(args, getSwarmItem);
    const tasks: SwarmTask<AgentSwarmSpec>[] = specs.map((spec) => {
      const descriptionName = spec.kind === 'resume' ? 'resume' : profileName;
      const common = {
        data: spec,
        profileName: spec.kind === 'resume' ? RESUMED_PROFILE_FALLBACK : profileName,
        parentToolCallId: toolCallId,
        prompt: spec.prompt,
        description: childDescription(args.description as string, spec.index, descriptionName),
        swarmIndex: spec.index,
        swarmItem: spec.item,
        timeout: timeoutMs,
        signal,
      };
      if (spec.kind === 'resume') {
        return { ...common, kind: 'resume' as const, resumeAgentId: spec.agentId };
      }
      return { ...common, kind: 'spawn' as const, plan: plan! };
    });
    const batchAborted = (): boolean => signal.aborted;
    const batch = new AgentRunBatch(buildBatchLauncher(batchAborted, onUpdate), tasks, {
      maxConcurrency: resolveSwarmMaxConcurrency(),
    });
    const results = await batch.run();
    return renderSwarmResults(
      results.map(({ task, ...result }) => ({ spec: task.data, ...result })),
    );
  };

  return {
    name: AGENT_SWARM_TOOL_NAME,
    get description() {
      return buildAgentSwarmDescription(models);
    },
    parameters: buildAgentSwarmParameters(models, forkEnabled()),
    async execute({ toolCall, signal, onUpdate }) {
      const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
      try {
        const args = parseAgentSwarmArguments(toolCall.arguments);
        if (args.description === undefined || args.description.trim().length === 0) {
          throw new Error('Provide a non-empty description for the swarm.');
        }
        return text(await runSwarm(args, signal, toolCall.id, onUpdate));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: message }], isError: true };
      }
    },
  };
}

export function createAgentSwarmSpecs(
  args: AgentSwarmArgs,
  getResumeItem: (agentId: string) => string | undefined,
): AgentSwarmSpec[] {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  const items = (args.items ?? []).map((item) => item.trim());
  const itemCount = items.length;
  const resumeCount = resumeEntries.length;
  const totalCount = resumeCount + itemCount;
  if (resumeCount === 0 && itemCount < 2) {
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
      item: getResumeItem(entry.agentId),
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

export function renderSwarmResults(results: readonly AgentSwarmSpecResult[]): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const shouldRenderResumeHint =
    results.some((result) => result.status !== 'completed' || result.stopReason !== undefined) &&
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
    const item =
      result.spec.item === undefined ? '' : ` item="${escapeXmlAttribute(result.spec.item)}"`;
    const state = result.state === undefined ? '' : ` state="${result.state}"`;
    const stopReason =
      result.stopReason === undefined
        ? ''
        : ` stop_reason="${escapeXmlAttribute(result.stopReason)}"`;
    const body =
      result.status === 'completed' ? (result.result ?? '') : (result.error ?? 'unknown error');
    lines.push(
      `<subagent${mode}${agentId}${item}${state} outcome="${result.status}"${stopReason}>${body}</subagent>`,
    );
  }

  lines.push('</agent_swarm_result>');
  return lines.join('\n');
}

function parseAgentSwarmArguments(raw: string | null): AgentSwarmArgs {
  const text = raw ?? '{}';
  try {
    return JSON.parse(text) as AgentSwarmArgs;
  } catch {
    throw new Error(`invalid AgentSwarm arguments: ${text}`);
  }
}

function attemptError(outcome: TurnOutcome, message: string): Error {
  const error = new Error(message) as Error & { kind?: string };
  const kind = llmErrorKindOf(outcome);
  if (kind !== undefined) error.kind = kind;
  return error;
}

function llmErrorKindOf(outcome: TurnOutcome): string | undefined {
  if (outcome.type !== 'failed' || outcome.failure.reason !== 'error') return undefined;
  const error = outcome.failure.error;
  if (typeof error !== 'object' || error === null) return undefined;
  const kind = (error as { readonly kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : undefined;
}

function abortReasonMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return classifyOutcome({ type: 'aborted', reason }).message;
}

function childDescription(swarmDescription: string, index: number, profileName: string): string {
  return `${swarmDescription} #${String(index)} (${profileName})`;
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

function buildAgentSwarmDescription(models: readonly SpawnModelEntry[]): string {
  const sections = [AGENT_SWARM_DESCRIPTION.trim()];
  if (models.length > 0) {
    const lines = models.map((entry) =>
      entry.description === undefined || entry.description.length === 0
        ? `- ${entry.name}`
        : `- ${entry.name}: ${entry.description}`,
    );
    lines.push('- primary: your current model and thinking level');
    sections.push(`Available models (pass via model):\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

function buildAgentSwarmParameters(
  models: readonly SpawnModelEntry[],
  forkEnabled: boolean,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    description: {
      type: 'string',
      minLength: 1,
      description: 'Short description for the whole swarm.',
    },
    subagent_type: {
      type: 'string',
      minLength: 1,
      description:
        'Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.',
    },
    prompt_template: {
      type: 'string',
      minLength: 1,
      description: `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
    },
    items: {
      type: 'array',
      maxItems: MAX_AGENT_SWARM_SUBAGENTS,
      items: { type: 'string', minLength: 1 },
      description: `Values used to fill ${PROMPT_TEMPLATE_PLACEHOLDER}. Each item launches one new subagent.`,
    },
  };
  if (forkEnabled) {
    properties['fork'] = {
      type: 'boolean',
      description:
        'Fork the current context for every item-spawned subagent: each starts with a snapshot of this agent\'s completed conversation history instead of zero context, inheriting this agent\'s agent type, tool set, and model. A non-empty resume_agent_ids map is rejected. If subagent_type is provided, it must match this agent\'s type; if model is provided, it must be this agent\'s model or "primary". Different types and model overrides are rejected. Use it only when every item builds on this conversation; keep independent tasks zero-context.',
    };
  }
  properties['resume_agent_ids'] = {
    type: 'object',
    propertyNames: { type: 'string', minLength: 1 },
    additionalProperties: { type: 'string', minLength: 1 },
    description:
      'Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.',
  };
  if (models.length > 0) {
    properties['model'] = {
      type: 'string',
      description:
        'Which model to run the item-spawned subagents on: one of the aliases listed under "Available models" in this tool description, or "primary" for your current model and thinking level. When omitted, the configured default model is used. Resumed subagents always keep their own model.',
    };
  }
  return { type: 'object', properties, required: ['description'], additionalProperties: false };
}
