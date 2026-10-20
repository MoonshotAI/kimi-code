import type { App } from '@moonshot-ai/agent-core/app/index';
import { addUsage, type AssistantMeta, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import { createUserMessage, extractText } from '@moonshot-ai/agent-core/llm/message';
import type { TokenUsage } from '@moonshot-ai/agent-core/llm/response';
import { MAX_STEPS_REASON, type TurnOutcome } from '@moonshot-ai/agent-core/loop/index';
import type { Agent, Session } from '@moonshot-ai/agent-core/session/index';

import { describeUnknownError } from '#/features/config/index';
import type { OsProcessPort } from '#/features/os/index';
import {
  agentCaps,
  createAgentRuntime,
  harnessInternals,
  syncAgentTools,
  type AgentRuntime,
} from '#/runtime/index';

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
import {
  applyProfilePromptPrefix,
  type AgentProfile,
  type ProfileCatalog,
} from './profile';

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
  readonly target: Agent;
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
  readonly session: Session;
  readonly agent: Agent;
  readonly app: App;
  readonly runtime: AgentRuntime;
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

interface EnsuredSubagent {
  readonly agent: Agent;
  readonly runtime: AgentRuntime;
}

function runtimeOf(app: App, session: Session, agentId: string): AgentRuntime {
  const internals = harnessInternals(app);
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
  return runtime;
}

async function ensureSubagent(app: App, session: Session, agentId: string): Promise<EnsuredSubagent> {
  const live = session.agents.get(agentId);
  const runtime = runtimeOf(app, session, agentId);
  const agent = live ?? (await session.open(agentId, agentCaps(runtime)));
  return { agent, runtime };
}

async function openSubagent(
  app: App,
  session: Session,
  agentId: string,
  source: string,
): Promise<EnsuredSubagent> {
  const runtime = runtimeOf(app, session, agentId);
  const agent = await session.open(agentId, agentCaps(runtime), { source });
  return { agent, runtime };
}

async function forkSubagent(
  app: App,
  session: Session,
  sourceId: string,
  agentId: string,
  source: string,
): Promise<EnsuredSubagent> {
  const runtime = runtimeOf(app, session, agentId);
  const agent = await session.fork(sourceId, agentId, agentCaps(runtime), { source });
  return { agent, runtime };
}

function profileToolAllowed(profile: AgentProfile, name: string): boolean {
  return (
    (profile.tools === undefined || profile.tools.includes(name)) &&
    !(profile.disallowedTools ?? []).includes(name)
  );
}

function trimSubagentTools(ensured: EnsuredSubagent, allowed: (name: string) => boolean): void {
  for (const name of ensured.runtime.tools.keys()) {
    if (!allowed(name)) ensured.runtime.tools.delete(name);
  }
  syncAgentTools(ensured.agent, ensured.runtime);
}

export function createSubagentLauncher(deps: SubagentLauncherDeps): SubagentLauncher {
  const { catalog, models, registry, session, agent, app } = deps;
  const callerAgentId = agent.id;

  const resume = async (
    resumeAgentId: string,
    prompt: string,
  ): Promise<LaunchedSubagent | string> => {
    const identity = parseSpawnSource(
      session.roster.getState().agents[resumeAgentId]?.source,
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
    let ensured: EnsuredSubagent;
    try {
      ensured = await ensureSubagent(app, session, resumeAgentId);
    } catch (error) {
      record.running = false;
      return `Agent instance "${resumeAgentId}" could not be reopened: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (ensured.runtime.requester === undefined) {
      ensured.runtime.requester = deps.runtime.requester;
    }
    await ensured.agent.flush();
    return {
      target: ensured.agent,
      agentId: resumeAgentId,
      profileName: record.profileName,
      promptText: prompt,
      historyBefore: ensured.agent.view.getState().messages.length,
    };
  };

  const launchPlanned = async (
    plan: Extract<SpawnPlan, { ok: true }>,
    prompt: string,
  ): Promise<LaunchedSubagent | string> => {
    const agentId = `subagent-${crypto.randomUUID().slice(0, 8)}`;
    const source = spawnSource(callerAgentId, plan.profileName);
    const ensured = plan.fork
      ? await forkSubagent(app, session, callerAgentId, agentId, source)
      : await openSubagent(app, session, agentId, source);
    const target = ensured.agent;
    const parentRequester = deps.runtime.requester;
    if (parentRequester === undefined) {
      if (plan.model.kind === 'explicit') {
        await session.close(agentId).catch(() => {});
        return MODEL_NOT_CONFIGURED_MESSAGE;
      }
    } else {
      ensured.runtime.requester =
        plan.model.kind === 'explicit'
          ? parentRequester.with({ model: { spec: plan.model.model } })
          : parentRequester;
    }
    if (plan.fork) {
      target.loop.remind({
        message: createUserMessage(FORK_CONTEXT_NOTICE),
        meta: { key: FORK_REMIND_KEY },
      });
      const inherited = agent.loop.state.profile.tools;
      if (inherited !== undefined) {
        const names = new Set(inherited.map((tool) => tool.name));
        trimSubagentTools(ensured, (name) => names.has(name));
      }
    } else {
      const profile = plan.profile;
      const rendered = profile?.renderSystemPrompt({ cwd: deps.workDir }).text;
      if (rendered !== undefined) target.loop.setSystemPrompt(rendered);
      if (profile !== undefined) {
        trimSubagentTools(ensured, (name) => profileToolAllowed(profile, name));
      }
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
    await target.flush();
    return {
      target,
      agentId,
      profileName: plan.profileName,
      modelName: plan.model.kind === 'explicit' ? plan.model.name : undefined,
      promptText,
      historyBefore: target.view.getState().messages.length,
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
  if (outcome.type === 'blocked') {
    if (outcome.cause.reason === MAX_STEPS_REASON) {
      return { reason: 'max_steps', message: outcome.cause.message ?? 'Agent turn failed' };
    }
    return { reason: 'error', message: outcome.cause.message ?? 'Agent turn failed' };
  }
  const error = outcome.error;
  const message =
    error instanceof Error
      ? error.message
      : error === undefined
        ? 'Agent turn failed'
        : describeUnknownError(error);
  return { reason: 'error', message };
}

function stoppedMessage(reason: unknown): string {
  const text =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  return text.length === 0 ? SUBAGENT_STOPPED_MESSAGE : `${SUBAGENT_STOPPED_MESSAGE} Reason: ${text}`;
}
