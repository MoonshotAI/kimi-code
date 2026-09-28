import { randomUUID } from 'node:crypto';

import {
  addUsage,
  createUserMessage,
  extractText,
  type AgentCommands,
  type AgentHandle,
  type AssistantMeta,
  type HistoryMessage,
  type SessionCommands,
  type TokenUsage,
  type ToolDefinition,
  type TurnFailure,
} from '@moonshot-ai/agent-core';
import type { RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';

import type { SpawnModelEntry, SpawnProfile, SpawnProfileCatalog } from './catalog';
import {
  FORK_CONTEXT_NOTICE,
  planSpawn,
  readProfileName,
  readResumeAgentId,
  validateSpawnArgs,
  type SpawnArgs,
} from './plan';
import {
  formatBackgroundAck,
  formatForegroundFailure,
  formatForegroundSuccess,
  SUBAGENT_STOPPED_MESSAGE,
  type SubagentStopReason,
} from './format';
import SPAWN_BACKGROUND_DESCRIPTION from './spawn-background.md?raw';
import SPAWN_DESCRIPTION from './spawn.md?raw';

export const SPAWN_TOOL_NAME = 'Agent';

export const FORK_REMIND_KEY = 'spawn.fork_context';

export const MODEL_NOT_CONFIGURED_MESSAGE = 'Caller agent has no model bound.';

export interface SpawnRecord {
  readonly parentAgentId: string;
  readonly profileName: string;
  running: boolean;
}

export type SpawnRegistry = Map<string, SpawnRecord>;

export interface SpawnToolDeps {
  readonly catalog: SpawnProfileCatalog;
  readonly models: readonly SpawnModelEntry[];
  readonly registry: SpawnRegistry;
  readonly session: SessionCommands;
  readonly agent: AgentCommands;
  readonly fire: (event: RuntimeEvent) => void;
  readonly forkEnabled: () => boolean;
}

type RunOutcome =
  | { readonly type: 'done' }
  | { readonly type: 'failed'; readonly failure: TurnFailure }
  | { readonly type: 'aborted'; readonly reason?: unknown };

interface LaunchedSubagent {
  readonly target: AgentHandle;
  readonly agentId: string;
  readonly profileName: string;
  readonly modelName?: string;
  readonly promptText: string;
  readonly historyBefore: number;
}

export const SPAWN_SOURCE_PREFIX = 'spawn:';

export function spawnSource(parentAgentId: string, profileName: string): string {
  return `${SPAWN_SOURCE_PREFIX}${parentAgentId}:${profileName}`;
}

export function parseSpawnSource(
  source: string | undefined,
): { readonly parentAgentId: string; readonly profileName: string } | undefined {
  if (source === undefined || !source.startsWith(SPAWN_SOURCE_PREFIX)) return undefined;
  const rest = source.slice(SPAWN_SOURCE_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return undefined;
  return { parentAgentId: rest.slice(0, sep), profileName: rest.slice(sep + 1) };
}

export function createSpawnTool(deps: SpawnToolDeps): ToolDefinition {
  const { catalog, models, registry, session, agent, fire, forkEnabled } = deps;
  const callerAgentId = agent.agentId;

  const historyLength = (agentId: string): number =>
    session.stores.get(agentId)?.getState().history.length ?? 0;

  const resume = async (resumeAgentId: string, prompt: string): Promise<LaunchedSubagent | string> => {
    const identity = parseSpawnSource(session.stores.session.getState().roster.agents[resumeAgentId]?.source);
    if (identity === undefined) {
      return `Agent instance "${resumeAgentId}" does not exist or is not a subagent.`;
    }
    if (identity.parentAgentId !== callerAgentId) {
      return `Agent instance "${resumeAgentId}" does not belong to this parent agent.`;
    }
    const record = registry.get(resumeAgentId) ?? {
      parentAgentId: identity.parentAgentId,
      profileName: identity.profileName,
      running: false,
    };
    if (record.running) {
      return `Agent instance "${resumeAgentId}" is already running and cannot run concurrently.`;
    }
    record.running = true;
    registry.set(resumeAgentId, record);
    let target = session.get(resumeAgentId);
    if (target === undefined) {
      try {
        target = await session.create({ agentId: resumeAgentId });
      } catch (error) {
        record.running = false;
        return `Agent instance "${resumeAgentId}" could not be reopened: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return {
      target,
      agentId: resumeAgentId,
      profileName: record.profileName,
      promptText: prompt,
      historyBefore: historyLength(resumeAgentId),
    };
  };

  const applyPromptPrefix = async (profile: SpawnProfile | undefined, prompt: string): Promise<string> => {
    if (profile?.promptPrefix === undefined) return prompt;
    const prefix = await profile.promptPrefix({ callerAgentId });
    return prefix.trim().length === 0 ? prompt : `${prefix}\n\n${prompt}`;
  };

  const launch = async (args: SpawnArgs): Promise<LaunchedSubagent | string> => {
    const prompt = args.prompt as string;
    const resumeAgentId = readResumeAgentId(args);
    if (resumeAgentId !== undefined) {
      return resume(resumeAgentId, prompt);
    }
    const plan = planSpawn(
      {
        callerAgentId,
        profileName: readProfileName(args),
        model: args.model,
        fork: args.fork === true,
      },
      { catalog, models },
    );
    if (!plan.ok) return plan.error;
    const agentId = `subagent-${randomUUID().slice(0, 8)}`;
    const source = spawnSource(callerAgentId, plan.profileName);
    const target = plan.fork
      ? await session.fork(callerAgentId, { agentId, source })
      : await session.create({
          agentId,
          systemPrompt: plan.profile?.systemPrompt({ callerAgentId }),
          source,
        });
    if (plan.fork) {
      target.remind(FORK_REMIND_KEY, createUserMessage(FORK_CONTEXT_NOTICE));
    }
    const callerConfig = agent.config;
    if (callerConfig === undefined) {
      if (plan.model.kind === 'explicit') {
        await session.close(agentId).catch(() => {});
        return MODEL_NOT_CONFIGURED_MESSAGE;
      }
    } else {
      target.setConfig(
        plan.model.kind === 'explicit' ? { ...callerConfig, model: plan.model.model } : callerConfig,
      );
    }
    registry.set(agentId, {
      parentAgentId: callerAgentId,
      profileName: plan.profileName,
      running: true,
    });
    return {
      target,
      agentId,
      profileName: plan.profileName,
      modelName: plan.model.kind === 'explicit' ? plan.model.name : undefined,
      promptText: await applyPromptPrefix(plan.profile, prompt),
      historyBefore: historyLength(agentId),
    };
  };

  return {
    name: SPAWN_TOOL_NAME,
    get description() {
      return buildSpawnDescription(deps);
    },
    parameters: buildSpawnParameters(models, forkEnabled()),
    async execute({ toolCall, signal, detach }) {
      const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
      try {
        signal.throwIfAborted();
        const args = JSON.parse(toolCall.arguments ?? '{}') as SpawnArgs;
        const staticError = validateSpawnArgs(
          args,
          {
            profileName: registry.get(callerAgentId)?.profileName,
            modelAlias: agent.config?.model.model,
          },
          forkEnabled(),
        );
        if (staticError !== undefined) return text(staticError);
        const runInBackground = args.run_in_background === true;
        const launched = await launch(args);
        if (typeof launched === 'string') return text(launched);
        const { target, agentId, profileName, promptText } = launched;
        fire({
          type: 'subagent.spawned',
          agentId,
          parentAgentId: callerAgentId,
          profile: profileName,
          model: launched.modelName,
          background: runInBackground,
        });
        if (runInBackground) {
          detach?.(formatBackgroundAck(toolCall.id, { agentId, profileName }, args.description));
        }
        let outcome: RunOutcome;
        try {
          outcome = await runAndWait(target, promptText, signal);
        } finally {
          const record = registry.get(agentId);
          if (record !== undefined) record.running = false;
        }
        const produced = session.stores.get(agentId)?.getState().history.slice(launched.historyBefore) ?? [];
        const summary = latestAssistantText(produced);
        if (outcome.type === 'done' && summary.trim().length > 0) {
          fire({ type: 'subagent.completed', agentId, summary, usage: sumUsage(produced) });
          return text(formatForegroundSuccess({ agentId, profileName }, summary));
        }
        const failure = classifyOutcome(outcome);
        if (outcome.type === 'aborted') {
          fire({ type: 'subagent.cancelled', agentId });
        } else {
          fire({ type: 'subagent.failed', agentId, error: failure.message });
        }
        return text(formatForegroundFailure({ agentId, profileName }, failure.message, failure.reason));
      } catch (error) {
        return text(`subagent error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

function buildSpawnParameters(
  models: readonly SpawnModelEntry[],
  forkEnabled: boolean,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    prompt: { type: 'string', description: 'Full task prompt for the subagent' },
    description: { type: 'string', description: 'Short task description (3-5 words) for UI display' },
    subagent_type: {
      type: 'string',
      description:
        'One of the available agent types (see "Available agent types" in this tool description). Defaults to "coder" when omitted.',
    },
    resume: {
      type: 'string',
      description:
        'Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.',
    },
    run_in_background: {
      type: 'boolean',
      description:
        'If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.',
    },
  };
  if (forkEnabled) {
    properties['fork'] = {
      type: 'boolean',
      description:
        'Fork the current context: the subagent starts with a snapshot of this agent\'s completed conversation history instead of zero context, inheriting this agent\'s tool set and model. A non-empty resume or a subagent_type is rejected; if model is provided, it must be this agent\'s model or "primary".',
    };
  }
  if (models.length > 0) {
    properties['model'] = {
      type: 'string',
      description:
        'Which model to run the subagent on: one of the aliases listed under "Available models" in this tool description, or "primary" for your current model and thinking level. When omitted, the caller\'s model is inherited. Ignored when resuming — resumed subagents keep their own model.',
    };
  }
  return { type: 'object', properties, required: ['prompt', 'description'] };
}

function buildSpawnDescription(deps: SpawnToolDeps): string {
  const sections = [SPAWN_DESCRIPTION.trim(), SPAWN_BACKGROUND_DESCRIPTION.trim()];
  const profiles = deps.catalog.list();
  if (profiles.length > 0) {
    const lines = profiles.map((profile) => {
      const tools =
        profile.tools === undefined ? 'all' : profile.tools.length === 0 ? 'none' : profile.tools.join(', ');
      return `- ${profile.name}: ${profile.description}\n  Tools: ${tools}`;
    });
    sections.push(`Available agent types (pass via subagent_type):\n${lines.join('\n')}`);
  }
  if (deps.models.length > 0) {
    const lines = deps.models.map((entry) =>
      entry.description === undefined || entry.description.length === 0
        ? `- ${entry.name}`
        : `- ${entry.name}: ${entry.description}`,
    );
    lines.push('- primary: your current model and thinking level');
    sections.push(`Available models (pass via model):\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

async function runAndWait(
  target: AgentHandle,
  prompt: string,
  signal: AbortSignal,
): Promise<RunOutcome> {
  if (signal.aborted) return { type: 'aborted', reason: signal.reason };
  const promptId = `spawn-${randomUUID()}`;
  const scope = new AbortController();
  const onAbort = (): void => scope.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const started = target.wait('turn.started', {
      match: (event) => event.queueItemId === promptId,
      signal: scope.signal,
    });
    void started.catch(() => {});
    const accepted = target.submit(createUserMessage(prompt), { promptId, origin: { kind: 'subagent' } });
    if (accepted === undefined) throw new Error('agent is not running');
    let turnId: number;
    try {
      turnId = (await started).turnId;
    } catch {
      target.cancel(promptId);
      return { type: 'aborted', reason: signal.reason };
    }
    try {
      return await target
        .wait('turn.done', { match: (event) => event.turnId === turnId, signal: scope.signal })
        .then((event): RunOutcome => event.outcome);
    } catch {
      target.abort(signal.reason);
      return { type: 'aborted', reason: signal.reason };
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    scope.abort();
  }
}

function latestAssistantText(messages: readonly HistoryMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i]!;
    if (entry.message.role !== 'assistant') continue;
    return extractText(entry.message);
  }
  return '';
}

function sumUsage(messages: readonly HistoryMessage[]): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const entry of messages) {
    if (entry.message.role !== 'assistant') continue;
    const usage = (entry.meta as AssistantMeta | undefined)?.usage;
    if (usage === undefined) continue;
    total = total === undefined ? usage : addUsage(total, usage);
  }
  return total;
}

function classifyOutcome(outcome: RunOutcome): { reason: SubagentStopReason; message: string } {
  if (outcome.type === 'done') {
    return { reason: 'no_final_message', message: 'Subagent turn ended without a final message.' };
  }
  if (outcome.type === 'aborted') {
    return { reason: 'stopped', message: stoppedMessage(outcome.reason) };
  }
  if (outcome.failure.reason === 'max_steps') {
    return { reason: 'max_steps', message: outcome.failure.message };
  }
  const error = outcome.failure.reason === 'error' ? outcome.failure.error : undefined;
  const message = error instanceof Error ? error.message : error === undefined ? 'Agent turn failed' : String(error);
  return { reason: 'error', message };
}

function stoppedMessage(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  return text.length === 0 ? SUBAGENT_STOPPED_MESSAGE : `${SUBAGENT_STOPPED_MESSAGE} Reason: ${text}`;
}
