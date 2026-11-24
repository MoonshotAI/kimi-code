import { isPromiseLike } from './result';

export type HookFunction = (...args: never[]) => unknown;
export type HookFailurePolicy = 'pause' | 'block';
export type HookMode = 'blocking' | 'nonblocking';

type NonBlockingArguments<F extends HookFunction> = F extends (...args: infer Args) => unknown ? {
  readonly [K in keyof Args]: Readonly<Args[K]>;
} : never;

export type NonBlockingHook<F extends HookFunction> = (
  ...args: NonBlockingArguments<F>
) => void | Promise<void>;

export type NonBlockingHooks<H extends { [P in keyof H]: HookFunction }> = {
  [P in keyof H]?: NonBlockingHook<H[P]>;
};

export interface HookRegistrationOptions {
  readonly id?: string;
  readonly onFailure?: HookFailurePolicy;
}

export interface BlockingHookRegistration<
  H extends { [P in keyof H]: HookFunction },
  P extends keyof H,
> extends HookRegistrationOptions {
  readonly point: P;
  readonly hook: H[P];
  readonly blocking?: true;
}

export interface NonBlockingHookRegistration<
  H extends { [P in keyof H]: HookFunction },
  P extends keyof H,
> {
  readonly point: P;
  readonly hook: NonBlockingHook<H[P]>;
  readonly id?: string;
  readonly blocking: false;
}

export type HookRegistration<H extends { [P in keyof H]: HookFunction }> = {
  [P in keyof H]: BlockingHookRegistration<H, P> | NonBlockingHookRegistration<H, P>;
}[keyof H];

export interface HookRegistrar<H extends { [P in keyof H]: HookFunction }, R> {
  <P extends keyof H>(registration: BlockingHookRegistration<H, P>): R;
  <P extends keyof H>(registration: NonBlockingHookRegistration<H, P>): R;
}

export interface HookItem<F extends HookFunction = HookFunction> {
  readonly id: string;
  readonly point: string;
  readonly hook: F;
  readonly onFailure: HookFailurePolicy;
  readonly mode: HookMode;
  paused: boolean;
}

export interface HookInfo {
  readonly id: string;
  readonly point: string;
  readonly onFailure: HookFailurePolicy;
  readonly paused: boolean;
  readonly mode: HookMode;
}

export type HookRegistryEvent =
  | { readonly type: 'hook.added'; readonly hookId: string; readonly point: string; readonly mode: HookMode }
  | { readonly type: 'hook.paused'; readonly hookId: string; readonly point: string; readonly reason: 'manual' | 'failed' }
  | { readonly type: 'hook.resumed'; readonly hookId: string; readonly point: string }
  | { readonly type: 'hook.removed'; readonly hookId: string; readonly point: string; readonly mode: HookMode }
  | {
      readonly type: 'hook.failed';
      readonly hookId: string;
      readonly point: string;
      readonly error: unknown;
      readonly paused: boolean;
      readonly blocking: false;
      readonly mode: 'nonblocking';
    };

export interface HookChainControl {
  invoke(item: HookItem, args: readonly unknown[]): unknown;
  invokeSync(item: HookItem, args: readonly unknown[]): unknown;
  notify(item: HookItem, args: readonly unknown[]): void;
  suspend(item: HookItem): void;
}

export type HookChains<H extends { [P in keyof H]: HookFunction }> = {
  [P in keyof H]: (
    items: readonly HookItem<H[P]>[],
    args: Parameters<H[P]>,
    control: HookChainControl,
  ) => ReturnType<H[P]> | Promise<Awaited<ReturnType<H[P]>>>;
};

export interface HookRegistry<H extends { [P in keyof H]: HookFunction }> {
  readonly add: HookRegistrar<H, string>;
  pause(id: string): boolean;
  resume(id: string): boolean;
  remove(id: string): boolean;
  list(): readonly HookInfo[];
  subscribe(listener: (event: HookRegistryEvent) => void): () => void;
}

export interface HookRegistryHandle<H extends { [P in keyof H]: HookFunction }> {
  readonly hook: H;
  readonly registry: HookRegistry<H>;
}

export function createHookRegistry<H extends { [P in keyof H]: HookFunction }>(
  chains: HookChains<H>,
): HookRegistryHandle<H> {
  const groups = new Map<string, HookItem[]>();
  const listeners = new Set<(event: HookRegistryEvent) => void>();
  let seq = 0;

  const emit = (event: HookRegistryEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  };

  const setPaused = (
    id: string,
    point: string | undefined,
    paused: boolean,
    reason: 'manual' | 'failed',
  ): boolean => {
    const group = groups.get(id);
    if (group === undefined) return false;
    let changed = false;
    for (const item of group) {
      if (point !== undefined && item.point !== point) continue;
      if (item.paused === paused) continue;
      item.paused = paused;
      changed = true;
      emit(
        paused
          ? { type: 'hook.paused', hookId: id, point: item.point, reason }
          : { type: 'hook.resumed', hookId: id, point: item.point },
      );
    }
    return changed;
  };

  const failNonBlocking = (item: HookItem, error: unknown): void => {
    setPaused(item.id, item.point, true, 'failed');
    emit({
      type: 'hook.failed',
      hookId: item.id,
      point: item.point,
      error,
      paused: true,
      blocking: false,
      mode: 'nonblocking',
    });
  };

  const invokeHook = (item: HookItem, args: readonly unknown[]): unknown => {
    const hook = item.hook as (...args: readonly unknown[]) => unknown;
    return hook(...args);
  };

  const control: HookChainControl = {
    invoke(item, args) {
      return invokeHook(item, args);
    },
    invokeSync(item, args) {
      const value = invokeHook(item, args);
      if (isPromiseLike(value)) throw new TypeError(`${item.point} hook must be synchronous`);
      return value;
    },
    notify(item, args) {
      let value: unknown;
      try {
        value = invokeHook(item, args);
      } catch (error) {
        failNonBlocking(item, error);
        return;
      }
      void Promise.resolve(value).catch((error: unknown) => {
        failNonBlocking(item, error);
      });
    },
    suspend(item) {
      setPaused(item.id, item.point, true, 'failed');
    },
  };

  const add = ((registration: {
    readonly point: keyof H;
    readonly hook: HookFunction;
    readonly id?: string;
    readonly onFailure?: HookFailurePolicy;
    readonly blocking?: boolean;
  }): string => {
    seq += 1;
    const { point, hook } = registration;
    const id = registration.id ?? `${String(point)}#${seq}`;
    if (groups.get(id)?.some((item) => item.point === String(point)) === true) {
      throw new Error(`hook ${id} already exists for ${String(point)}`);
    }
    const mode: HookMode = registration.blocking === false ? 'nonblocking' : 'blocking';
    const item: HookItem = {
      id,
      point: String(point),
      hook,
      onFailure: mode === 'nonblocking' ? 'pause' : registration.onFailure ?? 'pause',
      mode,
      paused: false,
    };
    groups.set(id, [...groups.get(id) ?? [], item]);
    emit({ type: 'hook.added', hookId: id, point: item.point, mode });
    return id;
  }) as HookRegistrar<H, string>;

  const registry: HookRegistry<H> = {
    add,
    pause: (id) => setPaused(id, undefined, true, 'manual'),
    resume: (id) => setPaused(id, undefined, false, 'manual'),
    remove(id) {
      const group = groups.get(id);
      if (group === undefined) return false;
      groups.delete(id);
      for (const item of group) emit({ type: 'hook.removed', hookId: id, point: item.point, mode: item.mode });
      return true;
    },
    list: () => [...groups.values()].flatMap((group) => group.map(({ id, point, onFailure, paused, mode }) => ({
      id,
      point,
      onFailure,
      paused,
      mode,
    }))),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const hook = {} as H;
  for (const point of Object.keys(chains)) {
    hook[point as keyof H] = ((...args: unknown[]) => {
      const items = [...groups.values()].flatMap((group) => group.filter((item) => item.point === point && !item.paused));
      for (const item of items) {
        if (item.mode === 'nonblocking') control.notify(item, args);
      }
      const blocking = items.filter((item) => item.mode === 'blocking');
      const chain = chains[point as keyof H] as unknown as (
        items: readonly HookItem[],
        args: unknown[],
        control: HookChainControl,
      ) => unknown;
      return chain(blocking, args, control);
    }) as unknown as H[keyof H];
  }

  return { hook, registry };
}
