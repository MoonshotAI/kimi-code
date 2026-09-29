import {
  AgentRunError,
  createFeature,
  createHistoryMessageBuilder,
  createUserMessage,
  MAIN_AGENT_ID,
  useSession,
  type FeatureSpec,
  type TurnFailure,
} from '@moonshot-ai/agent-core';
import { createToken, useExpose, useNode } from '@moonshot-ai/agent-core/kernel/index';

import { AgentsMdReminderRef } from '#/features/agentsMdReminder/index';
import type { OsHost } from '#/features/os/host/index';
import { PermissionRef, type PermissionMode } from '#/features/permission/index';
import { ProfileCatalogRef } from '#/features/profiles/index';

import { loadAgentsMdDetailed } from './agents-md';
import { DEFAULT_INIT_PROMPT, initCompletionReminder } from './init';

export const SESSION_INIT_FAILED = 'session.init_failed';
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

export const SessionInitRef = createToken<SessionInitFace>('sessionInit');

export interface CreateSessionInitProps {
  readonly workDir: string;
  readonly host?: OsHost;
  readonly brandHome?: string;
}

const INIT_PROFILE_NAME = 'coder';
const SESSION_INIT_SOURCE = 'session-init';

type RunOutcome =
  | { readonly type: 'done' }
  | { readonly type: 'failed'; readonly failure: TurnFailure }
  | { readonly type: 'aborted'; readonly reason?: unknown };

export function createSessionInit(props: CreateSessionInitProps): FeatureSpec {
  return createFeature('sessionInit', {
    session() {
      if (props.host === undefined) return;
      const host = props.host;
      const node = useNode();
      const session = useSession();
      const catalogEntries = node.providerRef(ProfileCatalogRef);
      let initRun: AbortController | undefined;

      const generateAgentsMd = async (): Promise<void> => {
        const main = session.get(MAIN_AGENT_ID);
        if (main === undefined) {
          throw new SessionInitError(AGENT_NOT_FOUND, 'Main agent was not found');
        }
        const config = main.config;
        if (config === undefined) {
          throw new SessionInitError(SESSION_INIT_FAILED, 'Main agent has no model bound');
        }
        const controller = new AbortController();
        initRun = controller;
        try {
          const systemPrompt = catalogEntries.value
            .at(-1)
            ?.value.get(INIT_PROFILE_NAME)
            ?.renderSystemPrompt({ cwd: props.workDir }).text;
          const agentId = `subagent-${crypto.randomUUID().slice(0, 8)}`;
          const child = await session.create({
            agentId,
            systemPrompt,
            source: SESSION_INIT_SOURCE,
          });
          let mode: PermissionMode | undefined;
          try {
            mode = main.resolve(PermissionRef).mode();
          } catch {
            mode = undefined;
          }
          if (mode !== undefined) {
            try {
              await child.resolve(PermissionRef).setMode(mode);
            } catch {}
          }
          child.setConfig(config);
          let outcome: RunOutcome;
          try {
            outcome = (
              await child.run(createUserMessage(DEFAULT_INIT_PROMPT), {
                meta: { origin: { kind: 'subagent' } },
                signal: controller.signal,
              })
            ).outcome;
          } catch (error) {
            if (error instanceof AgentRunError) throw error;
            const reason = controller.signal.reason;
            throw reason instanceof Error ? reason : new Error('Aborted');
          }
          if (outcome.type === 'aborted') {
            throw outcome.reason instanceof Error ? outcome.reason : new Error('Aborted');
          }
          if (outcome.type === 'failed') {
            const failure = outcome.failure;
            const cause = failure.reason === 'error' ? failure.error : undefined;
            const message =
              cause instanceof Error
                ? cause.message
                : failure.reason === 'max_steps'
                  ? failure.message
                  : 'Agent turn failed';
            throw new SessionInitError(SESSION_INIT_FAILED, message, { cause });
          }
          const { content, paths } = await loadAgentsMdDetailed(
            host,
            props.workDir,
            props.brandHome,
          );
          try {
            main.resolve(AgentsMdReminderRef).seed(paths);
          } catch {}
          main.remind(
            createHistoryMessageBuilder()
              .systemReminder(initCompletionReminder(content))
              .userMessage(),
            { key: SESSION_INIT_REMIND_KEY },
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
          if (initRun === controller) initRun = undefined;
        }
      };

      useExpose(SessionInitRef, {
        generateAgentsMd,
        cancelInit: (reason?: unknown) => {
          initRun?.abort(reason ?? abortError());
        },
      });
    },
  });
}

function abortError(): Error {
  return Object.assign(new Error('Aborted by the user'), { name: 'AbortError' });
}
