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
  type TurnOutcome,
} from '@moonshot-ai/agent-core';

import type { OsProcessPort } from '#/features/os/host/index';
import {
  applyProfilePromptPrefix,
  type ProfileCatalog,
} from '#/features/profiles/index';

import { SUBAGENT_STOPPED_MESSAGE, type SubagentStopReason } from './format';
import {
  FORK_CONTEXT_NOTICE,
  planSpawn,
  readProfileName,
  readResumeAgentId,
  type SpawnArgs,
  type SpawnModelEntry,
  type SpawnPlan,
} from './plan';

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

export const FORK_REMIND_KEY = 'spawn.fork_context';

export const MODEL_NOT_CONFIGURED_MESSAGE = 'Caller agent has no model bound.';

export interface SpawnRecord {
  readonly parentAgentId: string;
  readonly profileName: string;
  running: boolean;
}

export type SpawnRegistry = Map<string, SpawnRecord>;

export interface LaunchedSubagent {
  readonly target: AgentHandle;
  readonly agentId: string;
  readonly profileName: string;
  readonly modelName?: string;
  readonly promptText: string;
  readonly historyBefore: number;
}

export interface SubagentLauncherDeps {
  readonly catalog: ProfileCatalog;
  readonly models: readonly SpawnModelEntry[];
  readonly registry: SpawnRegistry;
  readonly session: SessionCommands;
  readonly agent: AgentCommands;
  readonly process?: OsProcessPort;
  readonly workDir: string;
}

export interface SubagentLauncher {
  launch(args: SpawnArgs): Promise<LaunchedSubagent | string>;
  launchPlanned(
    plan: Extract<SpawnPlan, { ok: true }>,
    prompt: string,
  ): Promise<LaunchedSubagent | string>;
  resume(resumeAgentId: string, prompt: string): Promise<LaunchedSubagent | string>;
}

export function createSubagentLauncher(deps: SubagentLauncherDeps): SubagentLauncher {
  const { catalog, models, registry, session, agent } = deps;
  const callerAgentId = agent.agentId;

  const historyLength = (agentId: string): number =>
    session.stores.get(agentId)?.getState().history.length ?? 0;

  const resume = async (
    resumeAgentId: string,
    prompt: string,
  ): Promise<LaunchedSubagent | string> => {
    const identity = parseSpawnSource(
      session.stores.session.getState().roster.agents[resumeAgentId]?.source,
    );
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

  const launchPlanned = async (
    plan: Extract<SpawnPlan, { ok: true }>,
    prompt: string,
  ): Promise<LaunchedSubagent | string> => {
    const agentId = `subagent-${crypto.randomUUID().slice(0, 8)}`;
    const source = spawnSource(callerAgentId, plan.profileName);
    const target = plan.fork
      ? await session.fork(callerAgentId, { agentId, source })
      : await session.create({
          agentId,
          systemPrompt: plan.profile?.renderSystemPrompt({ cwd: deps.workDir }).text,
          source,
        });
    if (plan.fork) {
      target.remind(createUserMessage(FORK_CONTEXT_NOTICE), { key: FORK_REMIND_KEY });
    }
    const callerConfig = agent.config;
    if (callerConfig === undefined) {
      if (plan.model.kind === 'explicit') {
        await session.close(agentId).catch(() => {});
        return MODEL_NOT_CONFIGURED_MESSAGE;
      }
    } else {
      target.setConfig(
        plan.model.kind === 'explicit'
          ? { ...callerConfig, model: plan.model.model }
          : callerConfig,
      );
    }
    registry.set(agentId, {
      parentAgentId: callerAgentId,
      profileName: plan.profileName,
      running: true,
    });
    const promptText =
      plan.fork || plan.profile === undefined
        ? prompt
        : await applyProfilePromptPrefix(plan.profile, prompt, {
            cwd: deps.workDir,
            process: deps.process,
          });
    return {
      target,
      agentId,
      profileName: plan.profileName,
      modelName: plan.model.kind === 'explicit' ? plan.model.name : undefined,
      promptText,
      historyBefore: historyLength(agentId),
    };
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
        callerProfileName: registry.get(callerAgentId)?.profileName,
        profileName: readProfileName(args),
        model: args.model,
        fork: args.fork === true,
      },
      { catalog, models },
    );
    if (!plan.ok) return plan.error;
    return launchPlanned(plan, prompt);
  };

  return { launch, launchPlanned, resume };
}

export function latestAssistantText(messages: readonly HistoryMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i]!;
    if (entry.message.role !== 'assistant') continue;
    return extractText(entry.message);
  }
  return '';
}

export function sumUsage(messages: readonly HistoryMessage[]): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const entry of messages) {
    if (entry.message.role !== 'assistant') continue;
    const usage = (entry.meta as AssistantMeta | undefined)?.usage;
    if (usage === undefined) continue;
    total = total === undefined ? usage : addUsage(total, usage);
  }
  return total;
}

export function classifyOutcome(outcome: TurnOutcome): {
  reason: SubagentStopReason;
  message: string;
} {
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
  const message =
    error instanceof Error
      ? error.message
      : error === undefined
        ? 'Agent turn failed'
        : String(error);
  return { reason: 'error', message };
}

function stoppedMessage(reason: unknown): string {
  const text =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  return text.length === 0 ? SUBAGENT_STOPPED_MESSAGE : `${SUBAGENT_STOPPED_MESSAGE} Reason: ${text}`;
}
