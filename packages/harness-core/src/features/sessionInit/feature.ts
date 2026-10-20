import {
  createFeature,
  useAgent,
  useApp,
  useSession,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import {
  createHistoryMessageBuilder,
  createUserEntry,
} from '@moonshot-ai/agent-core/history/index';
import {
  createFacadeToken,
  useCleanup,
  useExpose,
  useInject,
  type ShallowRef,
} from '@moonshot-ai/agent-core/kernel/index';
import { createUserMessage } from '@moonshot-ai/agent-core/llm/message';
import type { TurnOutcome } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, type Agent, type Session } from '@moonshot-ai/agent-core/session/index';

import {
  AgentsMdReminderRef,
  type AgentsMdReminderFace,
} from '#/features/agentsMdReminder/index';
import type { OsHost } from '#/features/os/host/index';
import { PermissionRef, type PermissionFace } from '#/features/permission/index';
import { ProfileCatalogRef } from '#/features/profiles/index';
import { agentCaps, createAgentRuntime, harnessInternals } from '#/runtime/index';

import { loadAgentsMdDetailed } from './agents-md';
import { DEFAULT_INIT_PROMPT, initCompletionReminder } from './init';

export const SESSION_INIT_FAILED = 'session.init_failed';
export const SESSION_INIT_BUSY = 'session.init_busy';
export const AGENT_NOT_FOUND = 'agent.not_found';

export class SessionInitError extends Error {
  readonly code: string;

  constructor(code: string, message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'SessionInitError';
    this.code = code;
  }
}

export const SESSION_INIT_REMIND_KEY = 'session-init';

export interface SessionInitFace {
  generateAgentsMd(): Promise<void>;
  cancelInit(reason?: unknown): void;
}

export const SessionInitRef = createFacadeToken<SessionInitFace>('sessionInit');

export interface CreateSessionInitProps {
  readonly workDir: string;
  readonly host?: OsHost;
  readonly brandHome?: string;
}

const INIT_PROFILE_NAME = 'coder';
const SESSION_INIT_SOURCE = 'session-init';

interface SessionInitState {
  controller?: AbortController;
}

export function createSessionInit(props: CreateSessionInitProps): Feature<void> {
  const states = new WeakMap<Session, SessionInitState>();
  const permissionFaces = new WeakMap<Agent, Readonly<ShallowRef<PermissionFace | undefined>>>();
  const reminderFaces = new WeakMap<Agent, Readonly<ShallowRef<AgentsMdReminderFace | undefined>>>();
  return createFeature('sessionInit', {
    session() {
      const host = props.host;
      if (host === undefined) return;
      const app = useApp();
      const session = useSession();
      const catalog = useInject(ProfileCatalogRef);
      const existing = states.get(session);
      const state = existing ?? {};
      if (existing === undefined) states.set(session, state);

      const generateAgentsMd = async (): Promise<void> => {
        if (state.controller !== undefined) {
          throw new SessionInitError(SESSION_INIT_BUSY, 'Session init is already running');
        }
        const main = session.agents.get(MAIN_AGENT_ID);
        if (main === undefined) {
          throw new SessionInitError(AGENT_NOT_FOUND, 'Main agent was not found');
        }
        const internals = harnessInternals(app);
        let perSession = internals.agents.get(session);
        if (perSession === undefined) {
          perSession = new Map();
          internals.agents.set(session, perSession);
        }
        const mainRequester = perSession.get(MAIN_AGENT_ID)?.requester;
        if (mainRequester === undefined) {
          throw new SessionInitError(SESSION_INIT_FAILED, 'Main agent has no model bound');
        }
        const controller = new AbortController();
        state.controller = controller;
        try {
          const systemPrompt = catalog.value
            ?.get(INIT_PROFILE_NAME)
            ?.renderSystemPrompt({ cwd: props.workDir }).text;
          const agentId = `subagent-${crypto.randomUUID().slice(0, 8)}`;
          let runtime = perSession.get(agentId);
          if (runtime === undefined) {
            runtime = createAgentRuntime(agentId);
            perSession.set(agentId, runtime);
          }
          const child = await session.open(agentId, agentCaps(runtime), {
            source: SESSION_INIT_SOURCE,
          });
          runtime.requester = mainRequester;
          if (systemPrompt !== undefined) child.loop.setSystemPrompt(systemPrompt);
          const mode = permissionFaces.get(main)?.value?.mode();
          if (mode !== undefined) {
            await permissionFaces
              .get(child)
              ?.value?.setMode(mode)
              .catch(() => {});
          }
          let outcome: TurnOutcome;
          try {
            outcome = await child.loop.runTurn(
              createUserEntry(createUserMessage(DEFAULT_INIT_PROMPT), {
                origin: { kind: 'subagent' },
              }),
              { signal: controller.signal },
            );
          } catch (error) {
            throw new SessionInitError(
              SESSION_INIT_FAILED,
              error instanceof Error ? error.message : 'Agent turn failed',
              { cause: error },
            );
          }
          if (outcome.type === 'aborted') {
            throw outcome.reason instanceof Error ? outcome.reason : new Error('Aborted');
          }
          if (outcome.type === 'failed') {
            const cause = outcome.error;
            throw new SessionInitError(
              SESSION_INIT_FAILED,
              cause instanceof Error ? cause.message : 'Agent turn failed',
              { cause },
            );
          }
          if (outcome.type === 'blocked') {
            throw new SessionInitError(
              SESSION_INIT_FAILED,
              outcome.cause.message ?? 'Agent turn failed',
            );
          }
          const { content, paths } = await loadAgentsMdDetailed(host, props.workDir, props.brandHome);
          try {
            reminderFaces.get(main)?.value?.seed(paths);
          } catch {}
          main.loop.remind(
            createUserEntry(
              createHistoryMessageBuilder()
                .systemReminder(initCompletionReminder(content))
                .userMessage(),
              { key: SESSION_INIT_REMIND_KEY },
            ),
          );
        } catch (error) {
          if (error instanceof SessionInitError) throw error;
          if (error instanceof Error && error.name === 'AbortError') throw error;
          throw new SessionInitError(
            SESSION_INIT_FAILED,
            error instanceof Error ? error.message : 'Init failed',
            { cause: error },
          );
        } finally {
          if (state.controller === controller) state.controller = undefined;
        }
      };

      useExpose(SessionInitRef, {
        generateAgentsMd,
        cancelInit: (reason?: unknown) => {
          state.controller?.abort(reason ?? abortError());
        },
      });
    },
    agent() {
      const agent = useAgent();
      const permission = useInject(PermissionRef);
      permissionFaces.set(agent, permission);
      useCleanup(() => {
        if (permissionFaces.get(agent) === permission) permissionFaces.delete(agent);
      });
      const reminder = useInject(AgentsMdReminderRef);
      reminderFaces.set(agent, reminder);
      useCleanup(() => {
        if (reminderFaces.get(agent) === reminder) reminderFaces.delete(agent);
      });
    },
  });
}

function abortError(): Error {
  return Object.assign(new Error('Aborted by the user'), { name: 'AbortError' });
}
