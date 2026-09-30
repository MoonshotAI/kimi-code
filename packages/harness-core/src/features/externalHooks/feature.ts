import {
  ConfigRef,
  createFeature,
  useAgent,
  useBeforeTool,
  useCleanup,
  useConfigSection,
  useInject,
  useOnAgent,
  useOnSession,
  useSession,
  type FeatureSpec,
  type PromptOrigin,
  type SessionCommands,
  type SessionRecord,
  type SessionStore,
  type ToolCall,
  type TurnFailure,
  type UserEntry,
} from '@moonshot-ai/agent-core';
import { useExpose, useReady } from '@moonshot-ai/agent-core/kernel/index';

import type { OsHost } from '#/features/os/index';
import { ProfileCatalogRef, type ProfileCatalogFace } from '#/features/profiles/index';
import { latestAssistantText, parseSpawnSource } from '#/features/spawn/index';
import type { TaskStartedEvent } from '#/features/task/index';

import { HOOKS_SECTION, hooksConfigSection } from './config-section';
import { matcherValueText } from './internal/match';
import type { HookDef, HookMatcherValue } from './internal/types';
import { createExternalHooksRunner, ExternalHooksRunnerRef } from './runner';

export interface CreateExternalHooksProps {
  readonly host?: OsHost;
  readonly workDir?: string;
  readonly clientType?: string;
  readonly shell?: string;
}

const HEARTBEAT_INTERVAL_MS = 60_000;

export function createExternalHooks(props: CreateExternalHooksProps = {}): FeatureSpec {
  return createFeature('externalHooks', {
    app() {
      useConfigSection(hooksConfigSection);
      if (props.host === undefined) return;
      const config = useInject(ConfigRef);
      const runner = createExternalHooksRunner({
        host: props.host,
        hooks: () =>
          config.value?.section<HookDef[]>(HOOKS_SECTION).value ?? [],
        workDir: props.workDir,
        clientType: props.clientType,
        shell: props.shell,
      });
      useExpose(ExternalHooksRunnerRef, runner);
    },
    session() {
      if (props.host === undefined) return;
      const session = useSession();
      const runner = useInject(ExternalHooksRunnerRef).value;
      if (runner === undefined) {
        throw new Error('externalHooks feature app slot is not installed');
      }
      const sessionTitle = trackSessionTitle(session.stores.session);
      const config = useInject(ConfigRef);
      const profiles = useInject(ProfileCatalogRef);
      let sessionOpened = false;
      const source = session.status().source;
      if (source === 'fork') {
        sessionOpened = true;
      } else {
        useReady(
          (async () => {
            await runner.trigger('SessionOpened', {
              matcherValue: source,
              sessionId: session.sessionId,
              inputData: {
                source,
                sessionTitle: sessionTitle(),
                model: config.value?.get<string | undefined>('defaultModel'),
                profile: defaultProfileNameOf(profiles.value),
              },
            });
            sessionOpened = true;
          })(),
        );
      }
      useCleanup(async () => {
        if (!sessionOpened) return;
        await runner.trigger('SessionClosed', {
          matcherValue: 'exit',
          sessionId: session.sessionId,
          inputData: { reason: 'exit', sessionTitle: sessionTitle() },
        });
      });
      const fireAndForget = (
        event: string,
        inputData: Record<string, unknown>,
        matcherValue?: HookMatcherValue,
      ): void => {
        try {
          void runner
            .fireAndForgetTrigger(event, {
              matcherValue,
              sessionId: session.sessionId,
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
              sessionId: session.sessionId,
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
      watchSubagentStops(session, fireAndForget);
    },
    agent() {
      if (props.host === undefined) return;
      const agent = useAgent();
      const session = useSession();
      const runner = useInject(ExternalHooksRunnerRef).value;
      if (runner === undefined) {
        throw new Error('externalHooks feature app slot is not installed');
      }
      const sessionTitle = trackSessionTitle(session.stores.session);
      const fireAndForget = (
        event: string,
        inputData: Record<string, unknown>,
        matcherValue?: HookMatcherValue,
      ): void => {
        try {
          void runner
            .fireAndForgetTrigger(event, {
              matcherValue,
              sessionId: session.sessionId,
              inputData: { sessionTitle: sessionTitle(), ...inputData },
            })
            .catch(() => {});
        } catch {}
      };

      useBeforeTool(async ({ toolCall }) => {
        const block = await runner.triggerBlock('PreToolUse', {
          matcherValue: toolCall.name,
          sessionId: session.sessionId,
          inputData: {
            sessionTitle: sessionTitle(),
            toolName: toolCall.name,
            toolInput: parseToolInput(toolCall),
            toolCallId: toolCall.id,
          },
        });
        if (block === undefined) return undefined;
        return {
          type: 'denied' as const,
          result: { content: [{ type: 'text' as const, text: block.reason }] },
        };
      });

      agent.on('turn.started', (event) => {
        const origin: PromptOrigin = event.entry?.meta?.origin ?? { kind: 'user' };
        fireAndForget(
          'TurnStarted',
          {
            turnId: event.turnId,
            originKind: origin.kind,
            originName: 'name' in origin ? origin.name : undefined,
            prompt:
              event.entry !== undefined && isDisplayablePromptOrigin(origin)
                ? turnPromptText(event.entry)
                : undefined,
          },
          origin.kind,
        );
      });

      agent.on('turn.done', (event) => {
        const { outcome } = event;
        if (outcome.type === 'failed') {
          const failure = outcome.failure;
          if (failure.reason === 'max_steps' || failure.error !== undefined) {
            const payload = failureErrorPayload(failure);
            fireAndForget(
              'StopFailure',
              { errorType: payload.name, errorMessage: payload.message },
              payload.name,
            );
          }
        }
        if (outcome.type === 'aborted') {
          fireAndForget('Interrupt', { turnId: event.turnId, reason: 'cancelled' });
        }
      });

      agent.on('prompt.submitted', (event) => {
        const origin = event.entry.meta?.origin;
        if (origin !== undefined && origin.kind !== 'user') return;
        const prompt = matcherValueText(event.entry.message.content);
        fireAndForget(
          'UserPromptQueued',
          { promptId: event.entry.meta?.promptId, prompt },
          prompt,
        );
      });

      useOnAgent('task.started', (event) => {
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
    },
  });
}

const SESSION_INIT_SOURCE = 'session-init';
const SESSION_INIT_PROFILE_NAME = 'coder';

interface AgentOpenedPayload {
  readonly agentId: string;
  readonly source?: string;
  readonly reopened?: boolean;
}

function subagentNameOf(payload: AgentOpenedPayload): string | undefined {
  const spawned = parseSpawnSource(payload.source);
  if (spawned !== undefined) return spawned.profileName;
  if (payload.source === SESSION_INIT_SOURCE) return SESSION_INIT_PROFILE_NAME;
  return undefined;
}

function watchSubagentStops(
  session: SessionCommands,
  fireAndForget: (event: string, inputData: Record<string, unknown>, matcherValue?: string) => void,
): void {
  const detachByAgent = new Map<string, () => void>();
  const attach = (agentId: string, agentName: string): void => {
    if (detachByAgent.has(agentId)) return;
    const target = session.get(agentId);
    if (target === undefined) return;
    const origins = new Map<number, string>();
    const started = target.on('turn.started', (event) => {
      const kind = event.entry?.meta?.origin?.kind;
      if (kind !== undefined) origins.set(event.turnId, kind);
    });
    const done = target.on('turn.done', (event) => {
      const kind = origins.get(event.turnId);
      origins.delete(event.turnId);
      if (kind !== 'subagent' && kind !== 'retry') return;
      if (event.outcome.type !== 'done') return;
      const response = latestAssistantText(event.messages);
      fireAndForget('SubagentStop', { agentName, response }, agentName);
    });
    detachByAgent.set(agentId, () => {
      started.unsubscribe();
      done.unsubscribe();
    });
  };
  useOnSession('agent.opened', (event) => {
    const payload = event as unknown as AgentOpenedPayload;
    const agentName = subagentNameOf(payload);
    if (agentName === undefined) return;
    attach(payload.agentId, agentName);
  });
  useOnSession('agent.closed', (event) => {
    const agentId = (event as unknown as { agentId: string }).agentId;
    detachByAgent.get(agentId)?.();
    detachByAgent.delete(agentId);
  });
  useCleanup(() => {
    for (const detach of detachByAgent.values()) detach();
    detachByAgent.clear();
  });
}

function trackSessionTitle(store: SessionStore): () => string | undefined {
  let title = (store.getState().sessionMeta.value as SessionRecord | undefined)?.title;
  useCleanup(
    store.onCommit((entry) => {
      if (entry.event['type'] !== 'session.meta_updated') return;
      const next = (entry.event['meta'] as SessionRecord | undefined)?.title;
      if (next !== undefined) title = next;
    }),
  );
  return () => title;
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

function failureErrorPayload(failure: TurnFailure): {
  readonly name?: string;
  readonly message: string;
} {
  if (failure.reason === 'max_steps') {
    return { name: failure.reason, message: failure.message };
  }
  return errorNameMessage(failure.error);
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
