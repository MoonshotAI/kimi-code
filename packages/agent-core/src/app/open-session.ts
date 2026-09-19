import { randomUUID } from 'node:crypto';

import { openSessionContainer } from '#/stores/session';

import type { SessionHandle, SessionUnitProps } from './sessionUnit';
import type { SessionRecord, SessionRecordDraft, SessionSpace } from './session-space';

export interface OpenSessionInput {
  readonly sessionId?: string;
  readonly title?: string;
  readonly workspaceId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly from?: string;
}

export interface SessionTable {
  get(sessionId: string): SessionHandle | undefined;
  create(props: SessionUnitProps): Promise<SessionHandle>;
}

export async function openSession(
  app: SessionTable,
  space: SessionSpace,
  input: OpenSessionInput = {},
): Promise<SessionHandle> {
  if (input.from === undefined && input.sessionId !== undefined) {
    const live = app.get(input.sessionId);
    if (live !== undefined) {
      return live;
    }
  }
  const existed = input.from === undefined && input.sessionId !== undefined && (await space.get(input.sessionId)) !== undefined;
  const sessionId = input.from !== undefined || input.sessionId === undefined
    ? input.sessionId ?? randomUUID()
    : input.sessionId;
  const container = await materializeContainer(space, sessionId, input);
  const opened = await openSessionContainer(container);
  const session = await app.create({
    sessionId,
    stores: opened.stores,
  });
  if (!existed || draftOf(input) !== undefined) {
    const record = await space.get(session.sessionId);
    if (record !== undefined) {
      await session.stores.session.dispatch({ type: 'session.meta_updated', meta: record });
    }
  }
  return session;
}

export async function updateSession(
  app: SessionTable,
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
