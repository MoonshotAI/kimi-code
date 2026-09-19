import { randomUUID } from 'node:crypto';

import {
  openSessionContainer,
  useApp,
  type AppCommands,
  type CreateAgentProps,
  type CreateSessionProps,
  type LlmRequester,
  type SessionHandle,
} from '@moonshot-ai/agent-core';
import { createToken, inject } from '@moonshot-ai/agent-core/kernel/index';

import {
  type SessionRecord,
  type SessionRecordDraft,
  type SessionSpace,
} from './session-space';

export * from './session-space';

export interface OpenSessionInput {
  readonly sessionId?: string;
  readonly title?: string;
  readonly workspaceId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly from?: string;
}

export interface OpenSessionResult extends CreateSessionProps {
  readonly agent?: CreateAgentProps;
}

export type OpenSession = (
  input: OpenSessionInput,
) => OpenSessionResult | Promise<OpenSessionResult>;

export type CreateSession = (input: OpenSessionInput) => Promise<SessionHandle>;

export type UpdateSession = (id: string, patch: SessionRecordDraft) => Promise<SessionRecord>;

export interface HarnessSessionBind {
  readonly requester: LlmRequester;
  readonly agent?: CreateAgentProps | ((input: OpenSessionInput) => CreateAgentProps | undefined);
}

export const SessionSpaceRef = createToken<SessionSpace>('harness.sessionSpace');

export const HarnessSessionBindRef = createToken<HarnessSessionBind>('harness.sessionBind');

export const OpenSessionRef = createToken<OpenSession>('harness.openSession');

export function useSessionSpace(): SessionSpace {
  return inject(SessionSpaceRef);
}

export function useOpenSession(): OpenSession {
  return inject(OpenSessionRef);
}

export function useCreateSession(): CreateSession {
  const app = useApp();
  const space = useSessionSpace();
  const openSession = useOpenSession();
  return (input) => createOpenedSession(app, space, openSession, input);
}

export function useUpdateSession(): UpdateSession {
  const app = useApp();
  const space = useSessionSpace();
  return (id, patch) => updateSessionRecord(app, space, id, patch);
}

export function bindOpenSession(space: SessionSpace, bind: HarnessSessionBind): OpenSession {
  return async (input) => {
    const sessionId = input.from !== undefined || input.sessionId === undefined
      ? input.sessionId ?? randomUUID()
      : input.sessionId;
    const container = await materializeContainer(space, sessionId, input);
    const opened = await openSessionContainer(container);
    return {
      sessionId,
      stores: opened.stores,
      requester: bind.requester,
      agent: resolveAgent(bind.agent, input),
    };
  };
}

export async function createOpenedSession(
  app: AppCommands,
  space: SessionSpace,
  openSession: OpenSession,
  input: OpenSessionInput,
): Promise<SessionHandle> {
  if (input.from === undefined && input.sessionId !== undefined) {
    const live = app.get(input.sessionId);
    if (live !== undefined) {
      return live;
    }
  }
  const existed = input.from === undefined && input.sessionId !== undefined && (await space.get(input.sessionId)) !== undefined;
  const opened = await openSession(input);
  const { agent, ...props } = opened;
  const session = await app.create(props);
  if (agent !== undefined) {
    await session.create(agent);
  }
  if (!existed || draftOf(input) !== undefined) {
    const record = await space.get(session.sessionId);
    if (record !== undefined) {
      await session.stores.session.dispatch({ type: 'session.meta_updated', meta: record });
    }
  }
  return session;
}

export async function updateSessionRecord(
  app: AppCommands,
  space: SessionSpace,
  id: string,
  patch: SessionRecordDraft,
): Promise<SessionRecord> {
  const record = await space.update(id, patch);
  const live = app.get(id);
  if (live !== undefined) {
    await live.stores.session.dispatch({ type: 'session.meta_updated', meta: record });
  }
  return record;
}

async function materializeContainer(
  space: SessionSpace,
  sessionId: string,
  input: OpenSessionInput,
): Promise<Awaited<ReturnType<SessionSpace['open']>>> {
  const draft = draftOf(input);
  if (input.from !== undefined) {
    const container = await space.copy(input.from, sessionId);
    if (draft !== undefined) {
      await space.update(sessionId, draft);
    }
    return container;
  }
  if ((await space.get(sessionId)) !== undefined) {
    if (draft !== undefined) {
      await space.update(sessionId, draft);
    }
    return space.open(sessionId);
  }
  return space.create(sessionId, draft);
}

function draftOf(input: OpenSessionInput): SessionRecordDraft | undefined {
  if (input.title === undefined && input.workspaceId === undefined && input.metadata === undefined) {
    return undefined;
  }
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

function resolveAgent(
  agent: HarnessSessionBind['agent'],
  input: OpenSessionInput,
): CreateAgentProps | undefined {
  if (agent === undefined) {
    return undefined;
  }
  return typeof agent === 'function' ? agent(input) : agent;
}
