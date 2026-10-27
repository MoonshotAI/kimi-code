import { shallowReactive } from '@vue/reactivity';

import {
  mountRoot,
  type CertainToken,
  type EventHandler,
  type FacadeToken,
  type ListenOpts,
  type MountRootOptions,
  type RuntimeEvent,
} from '#/composition-api/index';
import type { UnitNode } from '#/composition-api/runtime';
import type { WaitOpts } from '@moonshot-ai/agent-core/utils/wait';
import { setClock } from '@moonshot-ai/agent-core/utils/clock';
import { setNow } from '@moonshot-ai/agent-core/utils/now';
import { consoleLogWriter, createLogger, type Logger } from '@moonshot-ai/agent-core/log/index';
import {
  memorySessionSpace,
  createSession,
  SessionSpaceError,
  updateSessionMeta,
  type SessionContainer,
  type Session,
  type SessionMeta,
  type SessionRecord,
  type SessionRecordDraft,
  type SessionSource,
  type SessionSpace,
} from '@moonshot-ai/agent-core/session/index';

import {
  FEATURE_LEVELS,
  featureSetOf,
  type Feature,
  type FeatureEventMap,
  type FeatureEvents,
  type FeatureLevel,
  type FeatureScope,
  type FeatureSet,
  type Features,
} from './features';

import { createAppSession, type AppSession } from './session';
import { AppUnit, createHostFeature, RootRef } from './units';

export interface CreateSessionInput {
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
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly clock?: () => number;
}

export interface App {
  readonly space: SessionSpace;
  readonly sessions: ReadonlyMap<string, AppSession>;
  readonly features: Features;
  resolve<T>(token: CertainToken<T>): T;
  resolve<T>(token: FacadeToken<T>): T | undefined;
  create(input?: CreateSessionInput): Promise<AppSession>;
  open(sessionId: string, input?: CreateSessionInput): Promise<AppSession>;
  update(sessionId: string, patch: SessionMeta): Promise<SessionRecord>;
  close(sessionId?: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  on<E extends FeatureEventMap>(
    feature: Feature<any, E>,
    type: '*',
    handler: (event: FeatureEvents<E>) => void,
    opts?: ListenOpts,
  ): () => void;
  on<E extends FeatureEventMap, T extends FeatureEvents<E>['type']>(
    feature: Feature<any, E>,
    type: T,
    handler: (event: Extract<FeatureEvents<E>, { type: T }>) => void,
    opts?: ListenOpts,
  ): () => void;
  on<E extends RuntimeEvent = RuntimeEvent>(
    type: E['type'] | '*',
    handler: (event: E) => void,
    opts?: ListenOpts,
  ): () => void;
  wait<E extends FeatureEventMap>(feature: Feature<any, E>, type: '*', opts?: WaitOpts<FeatureEvents<E>>): Promise<FeatureEvents<E>>;
  wait<E extends FeatureEventMap, T extends FeatureEvents<E>['type']>(
    feature: Feature<any, E>,
    type: T,
    opts?: WaitOpts<Extract<FeatureEvents<E>, { type: T }>>,
  ): Promise<Extract<FeatureEvents<E>, { type: T }>>;
  wait<E extends RuntimeEvent = RuntimeEvent>(type: E['type'] | '*', opts?: WaitOpts<E>): Promise<E>;
}

function draftOf(input: CreateSessionInput): SessionRecordDraft | undefined {
  if (input.title === undefined && input.metadata === undefined) return undefined;
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

function legacyHealOf(folded: SessionMeta, record: SessionRecord | undefined): SessionMeta | undefined {
  if (record === undefined) return undefined;
  const title = folded.title === undefined ? record.title : undefined;
  const extra = Object.entries(record.metadata ?? {}).filter(
    ([key]) => !Object.hasOwn(folded.metadata ?? {}, key),
  );
  const metadata = extra.length > 0 ? Object.fromEntries(extra) : undefined;
  if (title === undefined && metadata === undefined) return undefined;
  return { title, metadata };
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
  const logger = options.logger ?? createLogger(consoleLogWriter);
  setNow(options.now);
  setClock(options.clock);
  const sessions = shallowReactive(new Map<string, AppSession>());
  const creating = new Map<string, Promise<AppSession>>();
  const closingSessions = new Map<string, Promise<void>>();
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
      previous.then(() => space.update(sessionId, patch)).then(
        () => undefined,
        (error) => logger.error('session index update failed', { sessionId }, error),
      ),
    );
  };

  const start = async (sessionId: string, input: CreateSessionInput): Promise<AppSession> => {
    const existed = input.from === undefined && (await space.get(sessionId)) !== undefined;
    const container = await containerOf(space, sessionId, input, existed);
    const source: SessionSource = input.from !== undefined ? 'fork' : existed ? 'resume' : 'startup';
    const record = await space.get(sessionId);
    let appSession: AppSession;
    let offMeta: () => void = () => {};
    const session: Session = await createSession({
      id: sessionId,
      ...container,
      source,
      logger,
      liveAgentsMap: () => shallowReactive(new Map()),
      lastTurn: record?.lastTurn,
      onLastTurn: (lastTurn) => index(sessionId, { lastTurn }),
      onClosed: () => {
        offMeta();
        if (sessions.get(sessionId) === appSession) sessions.delete(sessionId);
      },
    });
    let mirrored: SessionMeta = { title: record?.title, metadata: record?.metadata };
    offMeta = session.roster.subscribe((state) => {
      const meta = state.meta;
      if (meta.title === mirrored.title && meta.metadata === mirrored.metadata) return;
      mirrored = meta;
      index(sessionId, { title: meta.title, metadata: meta.metadata });
    });
    const heal = legacyHealOf(session.roster.getState().meta, record);
    if (heal !== undefined) await session.update(heal);
    appSession = createAppSession(session, settle);
    sessions.set(sessionId, appSession);
    if (!existed) emit({ type: 'session.created', sessionId, ...(input.from !== undefined ? { from: input.from } : {}) });
    await settle();
    return appSession;
  };

  const track = (sessionId: string, pending: Promise<AppSession>): Promise<AppSession> => {
    creating.set(sessionId, pending);
    const done = (): void => {
      if (creating.get(sessionId) === pending) creating.delete(sessionId);
    };
    pending.then(done, done);
    return pending;
  };

  const create: App['create'] = (input = {}) => {
    if (closing !== undefined) return Promise.reject(new Error('app is closed'));
    const sessionId = `session_${crypto.randomUUID()}`;
    return track(sessionId, start(sessionId, input));
  };

  const open: App['open'] = (sessionId, input = {}) => {
    if (closing !== undefined) return Promise.reject(new Error('app is closed'));
    if (input.from === undefined) {
      const live = sessions.get(sessionId) ?? creating.get(sessionId);
      if (live !== undefined) return Promise.resolve(live);
    }
    const closingSession = closingSessions.get(sessionId);
    const pending =
      closingSession === undefined ? start(sessionId, input) : closingSession.then(() => start(sessionId, input));
    return track(sessionId, pending);
  };

  const closeOne = async (sessionId: string): Promise<void> => {
    const task = (async () => {
      const session = sessions.get(sessionId);
      if (session !== undefined) {
        sessions.delete(sessionId);
        await session.close();
      }
      await indexing.get(sessionId);
      indexing.delete(sessionId);
      await settle();
    })();
    closingSessions.set(sessionId, task);
    try {
      await task;
    } finally {
      if (closingSessions.get(sessionId) === task) closingSessions.delete(sessionId);
    }
  };

  const targetOf = (scope: FeatureScope = {}): { readonly set: FeatureSet; readonly level: FeatureLevel } => {
    if (scope.session === undefined) return { set: featureSetOf(app), level: 'app' };
    const session = sessions.get(scope.session);
    if (session === undefined) throw new Error(`session '${scope.session}' is not open`);
    if (scope.agent === undefined) return { set: featureSetOf(session), level: 'session' };
    const agent = session.liveAgents.get(scope.agent);
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
    resolve: ((token: CertainToken<unknown> | FacadeToken<unknown>) => {
      const node = root;
      if (node === undefined) throw new Error('app is closed');
      return token.kind === 'facade' ? node.resolve(token) : node.resolve(token);
    }) as App['resolve'],
    create,
    open,
    update: async (sessionId, patch) => {
      const live = sessions.get(sessionId);
      if (live !== undefined) {
        await live.update(patch);
        await indexing.get(sessionId);
      } else {
        const container = await space.open(sessionId);
        await updateSessionMeta(container.journal, patch);
        await space.update(sessionId, patch);
      }
      const record = await space.get(sessionId);
      if (record === undefined) {
        throw new SessionSpaceError('not-found', `session '${sessionId}' does not exist`);
      }
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
      featureOrType: Feature | string,
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
      featureOrType: Feature | string,
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
  app.features.add(createHostFeature());
  return app;
}
