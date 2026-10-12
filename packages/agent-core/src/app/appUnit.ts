import type { MaybeRefOrGetter } from '@vue/reactivity';

import {
  createUnit,
  mountRoot,
  provide,
  shallowRef,
  toValue,
  type CertainToken,
  type FacadeToken,
  type MountRootOptions,
  type NodeRef,
  type UnitHandle,
  type UnitNode,
} from '#/kernel/index';
import { bindHandleOn, type FeatureHandleOn, type FeatureSpec } from '#/feature/feature';
import { AppUnitRef } from '#/feature/contribution-hooks';
import { useFeatureSlot } from '#/feature/hooks';
import { AppNodeRef } from '#/feature/tierNodes';

import { openSession, updateSession, type OpenSessionInput } from './open-session';
import { SessionSpaceError, type SessionRecord, type SessionRecordDraft, type SessionSpace } from './session-space';
import { SessionUnit, sessionHandle, type SessionHandle, type SessionUnitProps } from './sessionUnit';

export type CreateSessionProps = SessionUnitProps;

export interface AppUnitProps {
  readonly features?: MaybeRefOrGetter<readonly FeatureSpec[]>;
  readonly provide?: (node: NodeRef) => void;
  readonly space?: SessionSpace;
}

export interface AppCommands {
  readonly space: SessionSpace;
  list(): string[];
  get(sessionId: string): SessionHandle | undefined;
  create(props: CreateSessionProps): Promise<SessionHandle>;
  open(input?: OpenSessionInput): Promise<SessionHandle>;
  updateSession(id: string, patch: SessionRecordDraft): Promise<SessionRecord>;
  ready(): Promise<void>;
  close(): Promise<void>;
  close(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  installFeature(spec: FeatureSpec): void;
  uninstallFeature(feature: FeatureSpec | string): boolean;
}

export interface AppHandle extends UnitHandle, AppCommands, FeatureHandleOn {
  disposeAsync(): Promise<void>;
}

export const AppUnit = createUnit<AppUnitProps>('app', (props, ctx) => {
  const sessions = new Map<string, SessionHandle>();
  const installed = shallowRef<readonly FeatureSpec[]>([]);
  const appFeatures = (): readonly FeatureSpec[] => [
    ...toValue(props.features ?? []),
    ...installed.value,
  ];
  const requireSpace = (): SessionSpace => {
    if (props.space === undefined) {
      throw new Error('session space is not configured');
    }
    return props.space;
  };
  const sweep = (): void => {
    for (const [sessionId, session] of sessions) {
      if (session.state === 'unmounted') {
        sessions.delete(sessionId);
      }
    }
  };
  const commands: AppCommands = {
    get space() {
      return requireSpace();
    },
    list: () => {
      sweep();
      return [...sessions.keys()];
    },
    get: (sessionId) => {
      sweep();
      return sessions.get(sessionId);
    },
    create: async (createProps) => {
      await ctx.node.ready();
      sweep();
      if (sessions.has(createProps.sessionId)) {
        throw new Error(`session '${createProps.sessionId}' already exists`);
      }
      const handle = ctx.node.mount(SessionUnit, {
        ...createProps,
        features: [...appFeatures(), ...toValue(createProps.features ?? [])],
      });
      const session = sessionHandle(handle);
      sessions.set(createProps.sessionId, session);
      try {
        await session.ready();
      } catch (error) {
        sessions.delete(createProps.sessionId);
        await handle.unmount().catch(() => {});
        throw error;
      }
      return session;
    },
    open: (input) => openSession(commands, requireSpace(), input),
    updateSession: async (id, patch) => {
      const record = await updateSession(commands, requireSpace(), id, patch);
      if (commands.get(id) === undefined) {
        ctx.node.fire({ type: 'session.meta_updated', sessionId: id, meta: record });
      }
      return record;
    },
    ready: () => ctx.node.ready(),
    close: async (sessionId?: string) => {
      if (sessionId === undefined) {
        await ctx.node.unmount();
        return;
      }
      const session = sessions.get(sessionId);
      sessions.delete(sessionId);
      await session?.unmount();
    },
    delete: async (sessionId) => {
      const space = requireSpace();
      if ((await space.get(sessionId)) === undefined) {
        throw new SessionSpaceError('not-found', `session '${sessionId}' does not exist`);
      }
      await commands.close(sessionId);
      await space.delete(sessionId);
      ctx.node.fire({ type: 'session.deleted', sessionId });
    },
    installFeature: (spec) => {
      if (installed.value.some((entry) => entry === spec || entry.featureName === spec.featureName)) {
        throw new Error(`feature '${spec.featureName}' is already installed`);
      }
      installed.value = [...installed.value, spec];
    },
    uninstallFeature: (feature) => {
      const kept = installed.value.filter((entry) => entry !== feature && entry.featureName !== feature);
      if (kept.length === installed.value.length) {
        return false;
      }
      installed.value = kept;
      return true;
    },
  };
  provide(AppUnitRef, commands);
  provide(AppNodeRef, ctx.node);
  props.provide?.(ctx.node);
  useFeatureSlot('app', appFeatures);
  return commands;
});

export function appHandle(handle: UnitHandle): AppHandle {
  const commands = (): AppCommands => (handle.node as UnitNode).setupResult as AppCommands;
  return {
    get name() { return handle.name; },
    get state() { return handle.state; },
    node: handle.node,
    resolve: ((token: CertainToken<unknown> | FacadeToken<unknown>) =>
      token.kind === 'facade' ? handle.resolve(token) : handle.resolve(token)) as UnitHandle['resolve'],
    update: (props) => handle.update(props),
    ready: () => commands().ready(),
    unmount: () => handle.unmount(),
    disposeAsync: () => handle.unmount(),
    ...bindHandleOn(handle.node),
    list: () => commands().list(),
    get space() { return commands().space; },
    get: (sessionId) => commands().get(sessionId),
    create: (props) => commands().create(props),
    open: (input) => commands().open(input),
    updateSession: (id, patch) => commands().updateSession(id, patch),
    close: (sessionId?: string) =>
      sessionId === undefined ? commands().close() : commands().close(sessionId),
    delete: (sessionId) => commands().delete(sessionId),
    installFeature: (spec) => commands().installFeature(spec),
    uninstallFeature: (feature) => commands().uninstallFeature(feature),
  };
}

export function createHarness(props: AppUnitProps, opts?: MountRootOptions): AppHandle {
  return appHandle(mountRoot(AppUnit, props, opts).handle);
}
