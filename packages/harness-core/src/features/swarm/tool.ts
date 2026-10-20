import type { App } from '@moonshot-ai/agent-core/app/index';
import {
  createUserEntry,
  type HistoryMessage,
  type UserEntry,
} from '@moonshot-ai/agent-core/history/index';
import { createUserMessage } from '@moonshot-ai/agent-core/llm/message';
import type { LoopLlmRequester, TurnOutcome } from '@moonshot-ai/agent-core/loop/index';
import type { Agent, Session } from '@moonshot-ai/agent-core/session/index';
import type { ToolDefinition, ToolResult, ToolUpdate } from '@moonshot-ai/agent-core/tool/index';

import type { OsProcessPort } from '#/features/os/index';
import {
  classifyOutcome,
  createSubagentLauncher,
  DEFAULT_SUBAGENT_PROFILE_NAME,
  forkIncompatibility,
  FORK_EXPERIMENTAL_UNAVAILABLE,
  FORK_WITH_RESUME_UNAVAILABLE,
  latestAssistantText,
  planSpawn,
  SUBAGENT_UPDATE_KEY,
  sumUsage,
  type ProfileCatalog,
  type SpawnModelEntry,
  type SpawnPlan,
  type SpawnRegistry,
} from '#/features/spawn/index';
import {
  agentCaps,
  createAgentRuntime,
  harnessInternals,
  type AgentRuntime,
} from '#/runtime/index';

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
import {
  createAgentSwarmSpecs,
  MAX_AGENT_SWARM_SUBAGENTS,
  PROMPT_TEMPLATE_PLACEHOLDER,
  renderSwarmResults,
  type AgentSwarmArgs,
  type AgentSwarmSpec,
} from './specs';

export { AGENT_SWARM_TOOL_NAME };

const RESUMED_PROFILE_FALLBACK = 'subagent';

export type SwarmItemRegistry = Map<
  string,
  { readonly callerAgentId: string; readonly item: string }
>;

export interface AgentSwarmToolDeps {
  readonly app: App;
  readonly catalog: ProfileCatalog;
  readonly models: readonly SpawnModelEntry[];
  readonly registry: SpawnRegistry;
  readonly session: Session;
  readonly agent: Agent;
  readonly runtime: AgentRuntime;
  readonly forkEnabled: () => boolean;
  readonly process?: OsProcessPort;
  readonly workDir: string;
  readonly swarmItems: SwarmItemRegistry;
  readonly timeoutMs: () => number;
}

export function createAgentSwarmTool(deps: AgentSwarmToolDeps): ToolDefinition {
  const { catalog, models, registry, session, agent, forkEnabled, swarmItems } = deps;
  const callerAgentId = agent.id;
  const launcher = createSubagentLauncher({
    catalog,
    models,
    registry,
    session,
    agent,
    app: deps.app,
    runtime: deps.runtime,
    process: deps.process,
    workDir: deps.workDir,
  });

  const ensureAgent = async (agentId: string): Promise<Agent> => {
    const live = session.agents.get(agentId);
    if (live !== undefined) return live;
    const internals = harnessInternals(deps.app);
    let perSession = internals.agents.get(session);
    if (perSession === undefined) {
      perSession = new Map();
      internals.agents.set(session, perSession);
    }
    let runtime = perSession.get(agentId);
    if (runtime === undefined) {
      runtime = createAgentRuntime(agentId);
      perSession.set(agentId, runtime);
    }
    if (runtime.requester === undefined) {
      runtime.requester = deps.runtime.requester;
    }
    return session.open(agentId, agentCaps(runtime));
  };

  const getSwarmItem = (agentId: string): string | undefined => {
    const entry = swarmItems.get(agentId);
    return entry?.callerAgentId === callerAgentId ? entry.item : undefined;
  };

  const historyLength = async (agentId: string): Promise<number> => {
    const target = session.agents.get(agentId);
    if (target === undefined) return 0;
    await target.flush();
    return target.view.getState().messages.length;
  };

  const producedHistory = async (
    agentId: string,
    historyBefore: number,
  ): Promise<readonly HistoryMessage[]> => {
    const target = session.agents.get(agentId);
    if (target === undefined) return [];
    await target.flush();
    return target.view.getState().messages.slice(historyBefore);
  };

  const resetRunning = (agentId: string): void => {
    const record = registry.get(agentId);
    if (record !== undefined) record.running = false;
  };

  const runTargetTurn = (
    target: Agent,
    entry: UserEntry,
    signal: AbortSignal,
    onReady?: () => void,
  ): Promise<TurnOutcome> => {
    const unsubscribe = target.loop.subscribe((event) => {
      if (event.type !== 'turn.started') return;
      onReady?.();
    });
    return target.loop
      .runTurn(entry, { signal })
      .finally(() => {
        unsubscribe();
      });
  };

  const observe = (
    agentId: string,
    profileName: string,
    run: Promise<TurnOutcome>,
    historyBefore: number | Promise<number>,
    options: AgentRunAttemptOptions,
    batchAborted: () => boolean,
  ): AgentRunAttemptHandle => {
    const completion = run.then(async (outcome) => {
      const produced = await producedHistory(agentId, await historyBefore);
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
        runTargetTurn(
          launched.target,
          createUserEntry(createUserMessage(launched.promptText), {
            origin: { kind: 'subagent' },
          }),
          options.signal,
          options.onReady,
        ),
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
        runTargetTurn(
          launched.target,
          createUserEntry(createUserMessage(launched.promptText), {
            origin: { kind: 'subagent' },
          }),
          options.signal,
          options.onReady,
        ),
        launched.historyBefore,
        options,
        batchAborted,
      );
    },
    retry: async (agentId, options) => {
      options.signal.throwIfAborted();
      const target = session.agents.get(agentId) ?? (await ensureAgent(agentId));
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
      const historyBefore = historyLength(agentId);
      return observe(
        agentId,
        profileName,
        runTargetTurn(
          target,
          createUserEntry({ role: 'user', content: [] }, { origin: { kind: 'retry' } }),
          options.signal,
          options.onReady,
        ),
        historyBefore,
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
            modelAlias: callerModelName(deps.runtime.requester),
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
      try {
        const args = parseAgentSwarmArguments(toolCall.arguments);
        if (args.description === undefined || args.description.trim().length === 0) {
          throw new Error('Provide a non-empty description for the swarm.');
        }
        return textResult(await runSwarm(args, signal, toolCall.id, onUpdate));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: message }], isError: true as const };
      }
    },
  };
}

function textResult(value: string): ToolResult {
  return { content: [{ type: 'text' as const, text: value }] };
}

function callerModelName(requester: LoopLlmRequester | undefined): string | undefined {
  if (requester === undefined) return undefined;
  try {
    const model = requester.request({ content: { messages: [] } }).model;
    return model?.spec.name;
  } catch {
    return undefined;
  }
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
  if (outcome.type !== 'failed') return undefined;
  const error = outcome.error;
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
