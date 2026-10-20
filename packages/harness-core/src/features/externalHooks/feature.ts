import {
  createFeature,
  useAgent,
  useApp,
  useMessageAppending,
  useSession,
  useStepStarting,
  useStepStopping,
  useToolEnding,
  useToolStarting,
  type App,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import {
  shallowRef,
  useCleanup,
  useCollection,
  useExpose,
  useInject,
  useOn,
  useReady,
  watch,
} from '@moonshot-ai/agent-core/kernel/index';
import {
  createHistoryMessageBuilder,
  createUserEntry,
  type PromptOrigin,
  type UserEntry,
} from '@moonshot-ai/agent-core/history/index';
import type { ContentPart, ToolCall } from '@moonshot-ai/agent-core/llm/message';
import { MAX_STEPS_REASON, type Cause } from '@moonshot-ai/agent-core/loop/index';
import type { Agent, Session, SessionRecord } from '@moonshot-ai/agent-core/session/index';

import { ConfigRef, useConfigSection, type ConfigStore } from '#/features/config/index';
import type { OsHost } from '#/features/os/index';
import type { CompactionCompletedEvent, CompactionStartedEvent } from '#/features/compaction/index';
import { ProfileCatalogRef, type ProfileCatalogFace } from '#/features/profiles/index';
import { latestAssistantText, parseSpawnSource } from '#/features/spawn/index';
import type { TaskStartedEvent } from '#/features/task/index';
import { useLoopEvent } from '#/runtime/index';

import { HOOKS_SECTION, hooksConfigSection } from './config-section';
import { HookSources } from './hook-sources';
import { matcherValueText } from './internal/match';
import type { HookDef, HookMatcherValue } from './internal/types';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from './internal/userPrompt';
import { createExternalHooksRunner, ExternalHooksRunnerRef } from './runner';

export interface CreateExternalHooksProps {
  readonly host?: OsHost;
  readonly workDir?: string;
  readonly clientType?: string;
  readonly shell?: string;
}

const HEARTBEAT_INTERVAL_MS = 60_000;

type FireAndForget = (
  event: string,
  inputData: Record<string, unknown>,
  matcherValue?: HookMatcherValue,
) => void;

interface AgentEffect {
  readonly blockedPrompts: Map<number, Cause>;
  stopContinuation?: { readonly turnId: number; readonly used: boolean };
  pendingTurnStart?: { readonly turnId: number };
}

export function createExternalHooks(props: CreateExternalHooksProps = {}): Feature<void> {
  const agentEffects = new WeakMap<Agent, AgentEffect>();
  const subagentWatches = new WeakMap<Session, Map<string, () => void>>();
  const subagentTurnOrigins = new WeakMap<Agent, Map<number, string>>();
  return createFeature('externalHooks', {
    app() {
      useConfigSection(hooksConfigSection);
      if (props.host === undefined) return;
      const config = useInject(ConfigRef);
      const configStore = shallowRef<ConfigStore | undefined>();
      watch(
        config,
        (store) => {
          configStore.value = store;
        },
        { immediate: true },
      );
      const sources = useCollection(HookSources);
      const sourcedHooks = shallowRef<readonly HookDef[]>([]);
      const loadSources = async (): Promise<void> => {
        const loaded = await Promise.all(
          sources.value.map(async (source): Promise<readonly HookDef[]> => {
            try {
              return await source.load();
            } catch {
              return [];
            }
          }),
        );
        sourcedHooks.value = loaded.flat();
      };
      let sourceUnsubscribes: (() => void)[] = [];
      const syncSourceSubscriptions = (): void => {
        for (const unsubscribe of sourceUnsubscribes) unsubscribe();
        sourceUnsubscribes = [];
        for (const source of sources.value) {
          sourceUnsubscribes.push(
            source.onDidChange(() => {
              void loadSources();
            }),
          );
        }
      };
      syncSourceSubscriptions();
      watch(sources, () => {
        syncSourceSubscriptions();
        void loadSources();
      });
      void loadSources();
      useCleanup(() => {
        for (const unsubscribe of sourceUnsubscribes) unsubscribe();
        sourceUnsubscribes = [];
      });
      const runner = createExternalHooksRunner({
        host: props.host,
        hooks: () => [
          ...(configStore.value?.section<HookDef[]>(HOOKS_SECTION).value ?? []),
          ...sourcedHooks.value,
        ],
        workDir: props.workDir,
        clientType: props.clientType,
        shell: props.shell,
      });
      useExpose(ExternalHooksRunnerRef, runner);
    },
    session() {
      if (props.host === undefined) return;
      const app = useApp();
      const session = useSession();
      const runner = useInject(ExternalHooksRunnerRef).value;
      if (runner === undefined) {
        throw new Error('externalHooks feature app slot is not installed');
      }
      const config = useInject(ConfigRef);
      const profiles = useInject(ProfileCatalogRef);
      const sessionTitle = trackSessionTitle(app, session.id);
      let sessionOpened = false;
      let opening: Promise<void> | undefined;
      const source = session.source;
      if (source === 'fork') {
        sessionOpened = true;
      } else {
        const attempt = (async () => {
          await sessionTitle.ready;
          await runner.trigger('SessionOpened', {
            matcherValue: source,
            sessionId: session.id,
            inputData: {
              source,
              sessionTitle: sessionTitle(),
              model: config.value?.get<string | undefined>('defaultModel'),
              profile: defaultProfileNameOf(profiles.value),
            },
          });
          sessionOpened = true;
        })();
        opening = attempt;
        useReady(attempt);
      }
      useCleanup(async () => {
        await opening;
        if (!sessionOpened) return;
        await runner.trigger('SessionClosed', {
          matcherValue: 'exit',
          sessionId: session.id,
          inputData: { reason: 'exit', sessionTitle: sessionTitle() },
        });
      });
      const fireAndForget: FireAndForget = (event, inputData, matcherValue) => {
        try {
          void runner
            .fireAndForgetTrigger(event, {
              matcherValue,
              sessionId: session.id,
              inputData: { sessionTitle: sessionTitle(), ...inputData },
            })
            .catch(() => {});
        } catch {}
      };
      const createdAt = Date.now();
      const timer = setInterval(() => {
        try {
          if (!runner.hasHooksFor('SessionHeartbeat')) return;
          void runner
            .fireAndForgetTrigger('SessionHeartbeat', {
              sessionId: session.id,
              inputData: {
                sessionTitle: sessionTitle(),
                uptimeMs: Date.now() - createdAt,
              },
            })
            .catch(() => {});
        } catch {}
      }, HEARTBEAT_INTERVAL_MS);
      timer.unref?.();
      useCleanup(() => clearInterval(timer));
      watchSubagentActivity(session, fireAndForget);
    },
    agent() {
      if (props.host === undefined) return;
      const app = useApp();
      const agent = useAgent();
      const session = useSession();
      const runner = useInject(ExternalHooksRunnerRef).value;
      if (runner === undefined) {
        throw new Error('externalHooks feature app slot is not installed');
      }
      const sessionTitle = trackSessionTitle(app, session.id);
      const fireAndForget: FireAndForget = (event, inputData, matcherValue) => {
        try {
          void runner
            .fireAndForgetTrigger(event, {
              matcherValue,
              sessionId: session.id,
              inputData: { sessionTitle: sessionTitle(), ...inputData },
            })
            .catch(() => {});
        } catch {}
      };
      let effect = agentEffects.get(agent);
      if (effect === undefined) {
        effect = { blockedPrompts: new Map() };
        agentEffects.set(agent, effect);
      }
      const fx = effect;

      useToolStarting(async ({ toolCall }) => {
        const block = await runner.triggerBlock('PreToolUse', {
          matcherValue: toolCall.name,
          sessionId: session.id,
          inputData: {
            sessionTitle: sessionTitle(),
            toolName: toolCall.name,
            toolInput: parseToolInput(toolCall),
            toolCallId: toolCall.id,
          },
        });
        if (block === undefined) return undefined;
        return {
          blocked: { by: 'externalHooks', reason: 'pre_tool_use', message: block.reason },
          result: { content: [{ type: 'text' as const, text: block.reason }] },
        };
      });

      useToolEnding(({ toolCall, result, failed }) => {
        const output = toolOutputText(result.content);
        const isError = failed || result.isError === true;
        fireAndForget(
          isError ? 'PostToolUseFailure' : 'PostToolUse',
          {
            toolName: toolCall.name,
            toolInput: parseToolInput(toolCall),
            toolCallId: toolCall.id,
            error: isError ? errorNameMessage(output) : undefined,
            toolOutput: isError ? undefined : output.slice(0, 2000),
          },
          toolCall.name,
        );
        return undefined;
      });

      useMessageAppending(async ({ turnId, item }) => {
        if (item.kind === 'remind') return undefined;
        const isSteer = item.kind === 'notify' && item.entry.meta?.source === 'input';
        if (item.kind === 'notify' && !isSteer) return undefined;
        const entry = item.entry;
        if (entry.message.role !== 'user') return undefined;
        const origin = entry.meta?.origin;
        if (origin !== undefined && origin.kind !== 'user') return undefined;
        const prompt = entry.message.content;
        const results = await runner.trigger('UserPromptSubmit', {
          matcherValue: prompt,
          sessionId: session.id,
          inputData: { sessionTitle: sessionTitle(), prompt, isSteer },
        });
        const block = renderUserPromptHookBlockResult(results);
        if (block !== undefined) {
          const cause: Cause = {
            by: 'externalHooks',
            reason: 'user_prompt_submit',
            message: block.message,
          };
          fx.blockedPrompts.set(turnId, cause);
          return { blocked: cause };
        }
        const append = renderUserPromptHookResult(results);
        if (append === undefined) return undefined;
        return {
          entry: {
            message: {
              role: 'user' as const,
              content: [...prompt, ...createHistoryMessageBuilder().xml(append.text).parts()],
            },
            meta: entry.meta,
          },
        };
      });

      useStepStarting(({ turnId }) => {
        const cause = fx.blockedPrompts.get(turnId);
        if (cause === undefined) return undefined;
        fx.blockedPrompts.delete(turnId);
        return { blocked: cause };
      });

      useStepStopping(async ({ turnId, draft }) => {
        if (draft.type !== 'done') return undefined;
        if (draft.cause?.reason === 'stop_turn') return undefined;
        if (fx.stopContinuation?.turnId === turnId && fx.stopContinuation.used) return undefined;
        const block = await runner.triggerBlock('Stop', {
          sessionId: session.id,
          inputData: { sessionTitle: sessionTitle(), stopHookActive: false },
        });
        if (block === undefined) return undefined;
        fx.stopContinuation = { turnId, used: true };
        agent.loop.notify(
          createUserEntry(
            { role: 'user', content: [{ type: 'text' as const, text: block.reason }] },
            { source: 'notify', origin: STOP_HOOK_ORIGIN },
          ),
        );
        return {
          type: 'continue' as const,
          cause: { by: 'externalHooks', reason: 'stop_hook', message: block.reason },
        };
      });

      useLoopEvent('turn.started', ({ turnId }) => {
        fx.pendingTurnStart = { turnId };
      });

      useLoopEvent('message.appended', ({ turnId, source, entry }) => {
        const pending = fx.pendingTurnStart;
        if (pending === undefined || pending.turnId !== turnId) return;
        fx.pendingTurnStart = undefined;
        const promptEntry =
          source === 'normal' && entry.message.role === 'user' ? (entry as UserEntry) : undefined;
        const origin: PromptOrigin = promptEntry?.meta?.origin ?? { kind: 'user' };
        fireAndForget(
          'TurnStarted',
          {
            turnId,
            originKind: origin.kind,
            originName: 'name' in origin ? (origin as { readonly name?: unknown }).name : undefined,
            prompt:
              promptEntry !== undefined && isDisplayablePromptOrigin(origin)
                ? turnPromptText(promptEntry)
                : undefined,
          },
          origin.kind,
        );
      });

      useLoopEvent('turn.ended', ({ turnId, outcome }) => {
        const pending = fx.pendingTurnStart;
        if (pending !== undefined && pending.turnId === turnId) {
          fx.pendingTurnStart = undefined;
          fireAndForget(
            'TurnStarted',
            { turnId, originKind: 'user', originName: undefined, prompt: undefined },
            'user',
          );
        }
        if (outcome.type === 'failed' && outcome.error !== undefined) {
          const payload = errorNameMessage(outcome.error);
          fireAndForget(
            'StopFailure',
            { errorType: payload.name, errorMessage: payload.message },
            payload.name,
          );
        }
        if (outcome.type === 'blocked' && outcome.cause.reason === MAX_STEPS_REASON) {
          fireAndForget(
            'StopFailure',
            {
              errorType: MAX_STEPS_REASON,
              errorMessage: outcome.cause.message ?? outcome.cause.reason,
            },
            MAX_STEPS_REASON,
          );
        }
        if (outcome.type === 'aborted') {
          fireAndForget('Interrupt', { turnId, reason: 'cancelled' });
        }
      });

      useLoopEvent('prompt.submitted', ({ entry }) => {
        const origin = entry.meta?.origin;
        if (origin !== undefined && origin.kind !== 'user') return;
        const prompt = matcherValueText(entry.message.content);
        fireAndForget(
          'UserPromptQueued',
          { promptId: entry.meta?.promptId, prompt },
          prompt,
        );
      });

      useOn('task.started', (event) => {
        const record = (event as unknown as TaskStartedEvent).record;
        fireAndForget(
          'TaskStarted',
          {
            taskId: record.taskId,
            kind: record.toolName,
            description: record.description,
            status: record.status,
            detached: true,
            startedAt: record.startedAt,
          },
          record.toolName,
        );
      });

      useOn('permission.approval.requested', (event) => {
        const { type: _type, ...inputData } = event as unknown as Record<string, unknown>;
        fireAndForget('PermissionRequest', inputData, inputData['toolName'] as string | undefined);
      });

      useOn('permission.approval.resolved', (event) => {
        const { type: _type, ...inputData } = event as unknown as Record<string, unknown>;
        fireAndForget('PermissionResult', inputData, inputData['toolName'] as string | undefined);
      });

      useOn('compaction.started', (event) => {
        const { reason } = event as unknown as CompactionStartedEvent;
        fireAndForget('PreCompact', { trigger: reason, tokenCount: undefined }, reason);
      });

      useOn('compaction.completed', (event) => {
        const { reason, stats } = event as unknown as CompactionCompletedEvent;
        fireAndForget(
          'PostCompact',
          { trigger: reason, estimatedTokenCount: stats.tokensAfter },
          reason,
        );
      });
    },
  });

  function watchSubagentActivity(session: Session, fireAndForget: FireAndForget): void {
    let byAgent = subagentWatches.get(session);
    if (byAgent === undefined) {
      byAgent = new Map();
      subagentWatches.set(session, byAgent);
    }
    const attached = byAgent;
    const attach = (agentId: string, agentName: string): void => {
      if (attached.has(agentId)) return;
      const target = session.agents.get(agentId);
      if (target === undefined) return;
      let origins = subagentTurnOrigins.get(target);
      if (origins === undefined) {
        origins = new Map();
        subagentTurnOrigins.set(target, origins);
      }
      const turnOrigins = origins;
      const unsubscribe = target.loop.subscribe((event) => {
        if (event.type === 'message.appended') {
          if (event.source !== 'normal' || event.entry.message.role !== 'user') return;
          const entry = event.entry as UserEntry;
          const kind = entry.meta?.origin?.kind;
          if (kind !== undefined) turnOrigins.set(event.turnId, kind);
          if (kind === 'subagent') {
            fireAndForget('SubagentStart', { agentName, prompt: turnPromptText(entry) }, agentName);
          }
          return;
        }
        if (event.type !== 'turn.ended') return;
        const kind = turnOrigins.get(event.turnId);
        turnOrigins.delete(event.turnId);
        if (kind !== 'subagent' && kind !== 'retry') return;
        if (event.outcome.type !== 'done') return;
        void (async () => {
          await target.flush();
          const response = latestAssistantText(target.view.getState().messages);
          fireAndForget('SubagentStop', { agentName, response }, agentName);
        })().catch(() => {});
      });
      attached.set(agentId, unsubscribe);
    };
    useOn('agent.opened', (event) => {
      const { agentId, source } = event as { agentId?: unknown; source?: unknown };
      if (typeof agentId !== 'string') return;
      const agentName = subagentNameOf(typeof source === 'string' ? source : undefined);
      if (agentName === undefined) return;
      attach(agentId, agentName);
    });
    useOn('agent.closed', (event) => {
      const { agentId } = event as { agentId?: unknown };
      if (typeof agentId !== 'string') return;
      attached.get(agentId)?.();
      attached.delete(agentId);
    });
    for (const agentId of session.agents.keys()) {
      const agentName = subagentNameOf(session.roster.getState().agents[agentId]?.source);
      if (agentName !== undefined) attach(agentId, agentName);
    }
    useCleanup(() => {
      for (const detach of attached.values()) detach();
      attached.clear();
    });
  }
}

const SESSION_INIT_SOURCE = 'session-init';
const SESSION_INIT_PROFILE_NAME = 'coder';

interface StopHookOrigin extends PromptOrigin {
  readonly name: 'stop_hook';
}

const STOP_HOOK_ORIGIN: StopHookOrigin = { kind: 'system_trigger', name: 'stop_hook' };

function subagentNameOf(source: string | undefined): string | undefined {
  const spawned = parseSpawnSource(source);
  if (spawned !== undefined) return spawned.profileName;
  if (source === SESSION_INIT_SOURCE) return SESSION_INIT_PROFILE_NAME;
  return undefined;
}

interface SessionTitleTracker {
  (): string | undefined;
  readonly ready: Promise<void>;
}

function trackSessionTitle(app: App, sessionId: string): SessionTitleTracker {
  let title: string | undefined;
  const ready = app.space
    .get(sessionId)
    .then((record) => {
      title = record?.title;
    })
    .catch(() => {});
  const off = app.on('session.meta_updated', (event) => {
    const { sessionId: updated, meta } = event as {
      sessionId?: unknown;
      meta?: SessionRecord;
    };
    if (updated !== sessionId) return;
    if (meta?.title !== undefined) title = meta.title;
  });
  useCleanup(off);
  const get = (): string | undefined => title;
  return Object.assign(get, { ready });
}

function defaultProfileNameOf(catalog: ProfileCatalogFace | undefined): string | undefined {
  try {
    return catalog?.getDefault().name;
  } catch {
    return undefined;
  }
}

function parseToolInput(toolCall: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(toolCall.arguments ?? '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function toolOutputText(content: readonly ContentPart[]): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function isDisplayablePromptOrigin(origin: PromptOrigin): boolean {
  if (origin.kind === 'user') return true;
  if (origin.kind === 'cron_job' || origin.kind === 'cron_missed') return true;
  const extra = origin as unknown as Record<string, unknown>;
  if (origin.kind === 'system_trigger' && extra['name'] === 'subagent') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    extra['trigger'] === 'user-slash'
  );
}

function turnPromptText(entry: UserEntry): string | undefined {
  const text = entry.message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  return text.length > 0 ? text : undefined;
}

function errorNameMessage(error: unknown): {
  readonly name?: string;
  readonly message: string;
} {
  const llm = llmErrorPayloadOf(error);
  if (llm !== undefined) return { name: llm.kind, message: llm.message };
  if (error instanceof Error) return { name: error.name, message: error.message };
  if (typeof error === 'object' && error !== null) {
    const record = error as { readonly name?: unknown; readonly message?: unknown };
    if (typeof record.message === 'string') {
      return {
        name: typeof record.name === 'string' ? record.name : undefined,
        message: record.message,
      };
    }
  }
  return { name: undefined, message: String(error) };
}

function llmErrorPayloadOf(
  error: unknown,
): { readonly kind: string; readonly message: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as { readonly kind?: unknown; readonly message?: unknown };
  if (typeof record.kind !== 'string' || typeof record.message !== 'string') return undefined;
  return { kind: record.kind, message: record.message };
}
