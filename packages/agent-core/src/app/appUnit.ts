import type { MaybeRefOrGetter } from '@vue/reactivity';

import {
  createUnit,
  mountRoot,
  provide,
  shallowRef,
  toValue,
  type MountRootOptions,
  type NodeRef,
  type UnitHandle,
  type UnitNode,
} from '#/kernel/index';
import type { FeatureSpec } from '#/feature/feature';
import { AppUnitRef } from '#/feature/contribution-hooks';
import { useFeatureSlot } from '#/feature/hooks';

import { SessionUnit, sessionHandle, type SessionHandle, type SessionUnitProps } from './sessionUnit';

export type CreateSessionProps = SessionUnitProps;

export interface AppUnitProps {
  readonly features?: MaybeRefOrGetter<readonly FeatureSpec[]>;
  readonly provide?: (node: NodeRef) => void;
}

export interface AppCommands {
  list(): string[];
  get(sessionId: string): SessionHandle | undefined;
  create(props: CreateSessionProps): Promise<SessionHandle>;
  close(sessionId: string): Promise<void>;
  installFeature(spec: FeatureSpec): void;
  uninstallFeature(feature: FeatureSpec | string): boolean;
}

export interface AppHandle extends UnitHandle, AppCommands {
  disposeAsync(): Promise<void>;
}

export const AppUnit = createUnit<AppUnitProps>('app', (props, ctx) => {
  const sessions = new Map<string, SessionHandle>();
  const installed = shallowRef<readonly FeatureSpec[]>([]);
  const sweep = (): void => {
    for (const [sessionId, session] of sessions) {
      if (session.state === 'unmounted') {
        sessions.delete(sessionId);
      }
    }
  };
  const commands: AppCommands = {
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
      const handle = ctx.node.mount(SessionUnit, createProps);
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
    close: async (sessionId) => {
      const session = sessions.get(sessionId);
      sessions.delete(sessionId);
      await session?.unmount();
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
  props.provide?.(ctx.node);
  useFeatureSlot('app', () => [...toValue(props.features ?? []), ...installed.value]);
  return commands;
});

export function appHandle(handle: UnitHandle): AppHandle {
  const commands = (): AppCommands => (handle.node as UnitNode).setupResult as AppCommands;
  return {
    get name() { return handle.name; },
    get state() { return handle.state; },
    node: handle.node,
    update: (props) => handle.update(props),
    ready: () => handle.ready(),
    unmount: () => handle.unmount(),
    disposeAsync: () => handle.unmount(),
    list: () => commands().list(),
    get: (sessionId) => commands().get(sessionId),
    create: (props) => commands().create(props),
    close: (sessionId) => commands().close(sessionId),
    installFeature: (spec) => commands().installFeature(spec),
    uninstallFeature: (feature) => commands().uninstallFeature(feature),
  };
}

export function mountApp(props: AppUnitProps, opts?: MountRootOptions): AppHandle {
  return appHandle(mountRoot(AppUnit, props, opts).handle);
}
