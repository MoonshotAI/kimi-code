import { shallowReactive } from '@vue/reactivity';

import { mountRoot, type EventHandler, type ListenOpts, type MountRootOptions, type RuntimeEvent } from '#/kernel/index';
import type { UnitNode } from '#/kernel/runtime';
import type { WaitOpts } from '#/utils/wait';
import {
  memorySessionSpace,
  createSession,
  SessionSpaceError,
  type SessionContainer,
  type Session,
  type SessionRecord,
  type SessionRecordDraft,
  type SessionSource,
  type SessionSpace,
} from '#/session/index';

import {
  FEATURE_LEVELS,
  featureSetOf,
  type Feature,
  type FeatureLevel,
  type FeatureScope,
  type FeatureSet,
  type Features,
} from './features';
import { AppUnit, RootRef } from './units';

export interface CreateSessionInput {
  readonly sessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
  readonly from?: string;
}

export type AppEvent =
  | { readonly type: 'session.created'; readonly sessionId: string; readonly from?: string }
  | { readonly type: 'session.deleted'; readonly sessionId: string }
  | { readonly type: 'session.meta_updated'; readonly sessionId: string; readonly meta: SessionRecord };

export interface CreateAppOptions extends MountRootOptions {
  readonly space?: SessionSpace;
}

export interface App {
  readonly space: SessionSpace;
  readonly sessions: ReadonlyMap<string, Session>;
  readonly features: Features;
  create(input?: CreateSessionInput): Promise<Session>;
  update(sessionId: string, patch: SessionRecordDraft): Promise<SessionRecord>;
  close(sessionId?: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  on<E extends RuntimeEvent>(
    feature: Feature<any, E>,
    type: '*',
    handler: (event: E) => void,
    opts?: ListenOpts,
  ): () => void;
  on<E extends RuntimeEvent, T extends E['type']>(
    feature: Feature<any, E>,
    type: T,
    handler: (event: Extract<E, { type: T }>) => void,
    opts?: ListenOpts,
  ): () => void;
  on<E extends RuntimeEvent = RuntimeEvent>(
    type: E['type'] | '*',
    handler: (event: E) => void,
    opts?: ListenOpts,
  ): () => void;
  wait<E extends RuntimeEvent>(feature: Feature<any, E>, type: '*', opts?: WaitOpts<E>): Promise<E>;
  wait<E extends RuntimeEvent, T extends E['type']>(
    feature: Feature<any, E>,
    type: T,
    opts?: WaitOpts<Extract<E, { type: T }>>,
  ): Promise<Extract<E, { type: T }>>;
  wait<E extends RuntimeEvent = RuntimeEvent>(type: E['type'] | '*', opts?: WaitOpts<E>): Promise<E>;
}

function draftOf(input: CreateSessionInput): SessionRecordDraft | undefined {
  if (input.title === undefined && input.metadata === undefined) return undefined;
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

async function containerOf(
  space: SessionSpace,
  sessionId: string,
  input: CreateSessionInput,
  existed: boolean,
): Promise<SessionContainer> {
  const draft = draftOf(input);
  if (input.from === undefined && !existed) return space.create(sessionId, draft);
  const container = input.from !== undefined ? await space.copy(input.from, sessionId) : await space.open(sessionId);
  if (draft !== undefined) await space.update(sessionId, draft);
  return container;
}

export function createApp(options: CreateAppOptions = {}): App {
  const space = options.space ?? memorySessionSpace();
  const sessions = shallowReactive(new Map<string, Session>());
  const creating = new Map<string, Promise<Session>>();
  const indexing = new Map<string, Promise<void>>();
  let root: UnitNode | undefined;
  let closing: Promise<void> | undefined;

  const emit = (event: AppEvent): void => {
    root?.fire(event);
  };

  const settle = (): Promise<void> => root?.ready().catch(() => {}) ?? Promise.resolve();

  const index = (sessionId: string, patch: SessionRecordDraft): void => {
    const previous = indexing.get(sessionId) ?? Promise.resolve();
    indexing.set(
      sessionId,
      previous.then(() => space.update(sessionId, patch)).then(() => undefined, console.error),
    );
  };

  const start = async (sessionId: string, input: CreateSessionInput): Promise<Session> => {
    const existed = input.from === undefined && (await space.get(sessionId)) !== undefined;
    const container = await containerOf(space, sessionId, input, existed);
    const source: SessionSource = input.from !== undefined ? 'fork' : existed ? 'resume' : 'startup';
    const record = await space.get(sessionId);
    const session: Session = await createSession({
      id: sessionId,
      ...container,
      source,
      lastTurn: record?.lastTurn,
      onLastTurn: (lastTurn) => index(sessionId, { lastTurn }),
      onClosed: () => {
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      },
    });
    sessions.set(sessionId, session);
    if (!existed) emit({ type: 'session.created', sessionId, ...(input.from !== undefined ? { from: input.from } : {}) });
    return session;
  };

  const create: App['create'] = (input = {}) => {
    if (closing !== undefined) return Promise.reject(new Error('app is closed'));
    if (input.from === undefined && input.sessionId !== undefined) {
      const live = sessions.get(input.sessionId) ?? creating.get(input.sessionId);
      if (live !== undefined) return Promise.resolve(live);
    }
    const sessionId = input.sessionId ?? `session_${crypto.randomUUID()}`;
    const pending = start(sessionId, input);
    creating.set(sessionId, pending);
    const done = (): void => {
      if (creating.get(sessionId) === pending) creating.delete(sessionId);
    };
    pending.then(done, done);
    return pending;
  };

  const closeOne = async (sessionId: string): Promise<void> => {
    await sessions.get(sessionId)?.close();
    await indexing.get(sessionId);
    indexing.delete(sessionId);
    await settle();
  };

  const targetOf = (scope: FeatureScope = {}): { readonly set: FeatureSet; readonly level: FeatureLevel } => {
    if (scope.session === undefined) return { set: featureSetOf(app), level: 'app' };
    const session = sessions.get(scope.session);
    if (session === undefined) throw new Error(`session '${scope.session}' is not open`);
    if (scope.agent === undefined) return { set: featureSetOf(session), level: 'session' };
    const agent = session.agents.get(scope.agent);
    if (agent === undefined) throw new Error(`agent '${scope.agent}' of session '${scope.session}' is not open`);
    return { set: featureSetOf(agent), level: 'agent' };
  };

  const app: App = {
    space,
    sessions,
    features: {
      add: (feature, options) => {
        const { set, level } = targetOf(options);
        const reachable = FEATURE_LEVELS.slice(FEATURE_LEVELS.indexOf(level));
        if (!reachable.some((each) => feature.units[each] !== undefined)) {
          throw new TypeError(`feature '${feature.name}' has no unit at or below the ${level} scope`);
        }
        const remove = set.add({ feature, props: options?.props });
        return async () => {
          remove();
          await settle();
        };
      },
      delete: async (feature, scope) => {
        targetOf(scope).set.delete(typeof feature === 'string' ? feature : feature.name);
        await settle();
      },
      list: (scope) =>
        targetOf(scope)
          .set.entries()
          .map((entry) => entry.feature),
    },
    create,
    update: async (sessionId, patch) => {
      const record = await space.update(sessionId, patch);
      emit({ type: 'session.meta_updated', sessionId, meta: record });
      return record;
    },
    close: (sessionId) => {
      if (sessionId !== undefined) return closeOne(sessionId);
      closing ??= (async () => {
        await Promise.allSettled(creating.values());
        const node = root;
        root = undefined;
        await node?.dispose();
        await Promise.all([...sessions.keys()].map(closeOne));
      })();
      return closing;
    },
    delete: async (sessionId) => {
      if ((await space.get(sessionId)) === undefined) {
        throw new SessionSpaceError('not-found', `session '${sessionId}' does not exist`);
      }
      await closeOne(sessionId);
      await space.delete(sessionId);
      emit({ type: 'session.deleted', sessionId });
    },
    on: ((
      featureOrType: Feature<any, RuntimeEvent> | string,
      typeOrHandler: string | EventHandler,
      handlerOrOpts?: EventHandler | ListenOpts,
      opts?: ListenOpts,
    ) => {
      if (typeof featureOrType === 'string') {
        return root?.listen(featureOrType, typeOrHandler as EventHandler, handlerOrOpts as ListenOpts) ?? (() => {});
      }
      const type = typeOrHandler as string;
      const handler = handlerOrOpts as EventHandler;
      if (type !== '*') return root?.listen(type, handler, opts) ?? (() => {});
      const prefix = `${featureOrType.name}.`;
      let off = (): void => {};
      off =
        root?.listen('*', (event) => {
          if (!event.type.startsWith(prefix)) return;
          if (opts?.once === true) off();
          handler(event);
        }) ?? (() => {});
      return off;
    }) as App['on'],
    wait: ((
      featureOrType: Feature<any, RuntimeEvent> | string,
      typeOrOpts?: string | WaitOpts<RuntimeEvent>,
      opts?: WaitOpts<RuntimeEvent>,
    ) => {
      if (root === undefined) return Promise.reject(new Error('app is closed'));
      if (typeof featureOrType === 'string') return root.wait(featureOrType, typeOrOpts as WaitOpts<RuntimeEvent>);
      const type = typeOrOpts as string;
      if (type !== '*') return root.wait(type, opts);
      const prefix = `${featureOrType.name}.`;
      return root.wait('*', {
        match: (event) => event.type.startsWith(prefix) && (opts?.match?.(event) ?? true),
        timeoutMs: opts?.timeoutMs,
        signal: opts?.signal,
      });
    }) as App['wait'],
  };

  root = mountRoot(AppUnit, { app }, options).resolve(RootRef);
  return app;
}
