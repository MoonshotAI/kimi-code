import type {
  LoopHooks,
  HookFailurePolicy,
  HookInfo,
  HookLifecycleEvent,
  HookPoint,
  HookRegistration,
} from '../contract/hook';

export interface HookItem<P extends HookPoint = HookPoint> {
  readonly id: string;
  readonly point: P;
  readonly hook: LoopHooks[P];
  readonly onFailure: HookFailurePolicy;
  paused: boolean;
}

export interface HookRegistry {
  add(registration: HookRegistration): string;
  pause(id: string): boolean;
  resume(id: string): boolean;
  remove(id: string): boolean;
  list(): readonly HookInfo[];
}

export interface HookSource {
  active<P extends HookPoint>(point: P): readonly HookItem<P>[];
  suspend(id: string): void;
}

export function createHookRegistry(): HookRegistry &
  HookSource & { attach(listener: (event: HookLifecycleEvent) => void): void } {
  const items = new Map<string, HookItem>();
  let listener: ((event: HookLifecycleEvent) => void) | undefined;
  let seq = 0;
  const notify = (event: HookLifecycleEvent) => listener?.(event);
  const setPaused = (id: string, paused: boolean, reason: 'manual' | 'failed'): boolean => {
    const item = items.get(id);
    if (item === undefined || item.paused === paused) return false;
    item.paused = paused;
    notify(
      paused
        ? { type: 'hook.paused', hookId: id, point: item.point, reason }
        : { type: 'hook.resumed', hookId: id, point: item.point },
    );
    return true;
  };
  return {
    attach(next) {
      listener = next;
    },
    add(registration) {
      seq += 1;
      const id = registration.id ?? `${registration.point}#${seq}`;
      if (items.has(id)) throw new Error(`hook ${id} already exists`);
      items.set(id, {
        id,
        point: registration.point,
        hook: registration.hook,
        onFailure: registration.onFailure ?? 'pause',
        paused: false,
      } as HookItem);
      notify({ type: 'hook.added', hookId: id, point: registration.point });
      return id;
    },
    pause: (id) => setPaused(id, true, 'manual'),
    resume: (id) => setPaused(id, false, 'manual'),
    remove(id) {
      const item = items.get(id);
      if (item === undefined) return false;
      items.delete(id);
      notify({ type: 'hook.removed', hookId: id, point: item.point });
      return true;
    },
    list: () =>
      [...items.values()].map(({ id, point, onFailure, paused }) => ({ id, point, onFailure, paused })),
    active: <P extends HookPoint>(point: P) =>
      [...items.values()].filter((item): item is HookItem<P> => item.point === point && !item.paused),
    suspend(id) {
      setPaused(id, true, 'failed');
    },
  };
}
