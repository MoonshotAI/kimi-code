import { existsSync, watch as fsWatch, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { FSWatcher } from 'chokidar';

import {
  assign,
  createActor,
  emit,
  fromCallback,
  setup,
  stopChild,
  type ActorRefFrom,
  type Subscription,
} from '#/xstate2';

export type WatchChangeAction = 'created' | 'modified' | 'deleted';
export type WatchChangeKind = 'file' | 'directory';

export interface WatchChange {
  readonly path: string;
  readonly action: WatchChangeAction;
  readonly kind: WatchChangeKind;
}

export interface WatchOptions {
  readonly recursive?: boolean;
  readonly ignored?: (path: string) => boolean;
  readonly depth?: number;
  readonly signal?: boolean;
  readonly listing?: boolean;
}

export interface WatchSubscription {
  dispose(): void;
}

export interface WatchHandle {
  readonly ready: Promise<void>;
  onDidChange(listener: (change: WatchChange) => void): WatchSubscription;
  dispose(): void;
}

export interface NativeFsWatcher {
  close(): void;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): this;
}

export interface WatchRuntime {
  readonly platform: NodeJS.Platform;
  readonly resolvePath?: (path: string) => string;
  watchNative(
    root: string,
    listener: (eventType: string, filename: string | null) => void,
    options?: { readonly recursive?: boolean },
  ): NativeFsWatcher;
  scheduleRetry(callback: () => void, delayMs: number): WatchSubscription;
  reportError(error: unknown): void;
}

const DEFAULT_IGNORED = (p: string): boolean => /(?:^|[/\\])\.git(?:$|[/\\])/.test(p);

const CHOKIDAR_EVENTS: Record<string, { action: WatchChangeAction; kind: WatchChangeKind }> = {
  add: { action: 'created', kind: 'file' },
  addDir: { action: 'created', kind: 'directory' },
  change: { action: 'modified', kind: 'file' },
  unlink: { action: 'deleted', kind: 'file' },
  unlinkDir: { action: 'deleted', kind: 'directory' },
};

const NATIVE_RETRY_BASE_MS = 1000;
const NATIVE_RETRY_MAX_MS = 30000;
const LISTING_MISSING_RETRY_MS = 250;

const NODE_WATCH_RUNTIME: WatchRuntime = {
  platform: process.platform,
  resolvePath: (path) =>
    process.platform === 'win32' && /~\d/.test(path) ? resolveLongPath(path) : path,
  watchNative: (root, listener, options) =>
    fsWatch(root, { persistent: false, recursive: options?.recursive !== false }, listener),
  scheduleRetry: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return {
      dispose: () => {
        clearTimeout(timer);
      },
    };
  },
  reportError: (error) => console.error(error),
};

interface WatchMachineInput {
  readonly path: string;
  readonly options?: WatchOptions;
  readonly runtime: WatchRuntime;
}

interface WatchMachineContext {
  readonly input: WatchMachineInput;
  readonly ignored: (path: string) => boolean;
  readonly ready: boolean;
  readonly failed?: unknown;
  readonly retryAttempts: number;
  readonly retryDelayMs: number;
  readonly recovering: boolean;
  readonly chokidarDepth?: number;
  readonly nativeRecursive: boolean;
}

type WatchEvent =
  | { type: 'leg.ready' }
  | { type: 'leg.error'; error: unknown }
  | { type: 'leg.change'; change: WatchChange }
  | { type: 'leg.nativeStarted' }
  | { type: 'leg.nativeEvent'; filename: string | null }
  | { type: 'leg.nativeError'; error: NodeJS.ErrnoException }
  | { type: 'leg.retryFired' };

type WatchEmitted = { type: 'change'; change: WatchChange };

interface ChokidarLegInput {
  readonly path: string;
  readonly depth?: number;
  readonly ignored: (path: string) => boolean;
}

const chokidarLeg = fromCallback<WatchEvent, ChokidarLegInput>(({ input, sendBack }) => {
  const watcher = new FSWatcher({
    ignoreInitial: true,
    persistent: false,
    followSymlinks: false,
    depth: input.depth,
    ignored: input.ignored,
  });
  watcher.on('all', (eventName: string, absPath: string) => {
    const mapped = CHOKIDAR_EVENTS[eventName];
    if (mapped !== undefined) sendBack({ type: 'leg.change', change: { path: absPath, ...mapped } });
  });
  watcher.on('error', (error: unknown) => sendBack({ type: 'leg.error', error }));
  watcher.once('ready', () => sendBack({ type: 'leg.ready' }));
  watcher.add(input.path);
  return () => {
    void watcher.close().catch(() => undefined);
  };
});

interface NativeLegInput {
  readonly root: string;
  readonly runtime: WatchRuntime;
  readonly recursive: boolean;
}

const nativeLeg = fromCallback<WatchEvent, NativeLegInput>(({ input, sendBack }) => {
  let watcher: NativeFsWatcher;
  try {
    watcher = input.runtime.watchNative(
      input.root,
      (_eventType, filename) => {
        sendBack({ type: 'leg.nativeEvent', filename });
      },
      { recursive: input.recursive },
    );
  } catch (error) {
    sendBack({ type: 'leg.nativeError', error: error as NodeJS.ErrnoException });
    return () => {};
  }
  watcher.on('error', (error) => sendBack({ type: 'leg.nativeError', error }));
  sendBack({ type: 'leg.nativeStarted' });
  return () => {
    watcher.close();
  };
});

interface RetryLegInput {
  readonly runtime: WatchRuntime;
  readonly delayMs: number;
}

const retryLeg = fromCallback<WatchEvent, RetryLegInput>(({ input, sendBack }) => {
  const retry = input.runtime.scheduleRetry(() => sendBack({ type: 'leg.retryFired' }), input.delayMs);
  return () => {
    retry.dispose();
  };
});

const watchMachine = setup({
  types: {
    input: {} as WatchMachineInput,
    context: {} as WatchMachineContext,
    events: {} as WatchEvent,
    emitted: {} as WatchEmitted,
  },
  actors: { chokidarLeg, nativeLeg, retryLeg },
}).createMachine({
  id: 'watch',
  initial: 'starting',
  context: ({ input }) => ({
    input,
    ignored: input.options?.ignored ?? DEFAULT_IGNORED,
    ready: false,
    retryAttempts: 0,
    retryDelayMs: 0,
    recovering: false,
    nativeRecursive: true,
  }),
  states: {
    starting: {
      always: [
        {
          guard: ({ context }) => context.input.options?.listing === false,
          target: 'native',
          actions: assign({ nativeRecursive: false }),
        },
        {
          guard: ({ context }) =>
            context.input.options?.signal === true &&
            context.input.options.recursive !== false &&
            (context.input.runtime.platform === 'darwin' ||
              context.input.runtime.platform === 'win32'),
          target: 'native',
        },
        {
          target: 'chokidar',
          actions: assign({
            chokidarDepth: ({ context }) =>
              context.input.options?.depth ??
              (context.input.options?.recursive === false ? 0 : undefined),
          }),
        },
      ],
    },
    chokidar: {
      invoke: {
        src: 'chokidarLeg',
        input: ({ context }) => ({
          path: context.input.path,
          depth: context.chokidarDepth,
          ignored: context.ignored,
        }),
      },
      on: {
        'leg.ready': {
          actions: assign({ ready: true }),
        },
        'leg.error': {
          actions: [
            assign({
              failed: ({ context, event }) => (context.ready ? context.failed : event.error),
            }),
            ({ context, event }) => context.input.runtime.reportError(event.error),
          ],
        },
        'leg.change': {
          actions: emit(({ event }) => ({ type: 'change' as const, change: event.change })),
        },
      },
    },
    native: {
      invoke: {
        src: 'nativeLeg',
        input: ({ context }) => ({
          root: context.input.path,
          runtime: context.input.runtime,
          recursive: context.nativeRecursive,
        }),
      },
      on: {
        'leg.nativeStarted': [
          {
            guard: ({ context }) => context.recovering,
            actions: [
              assign({ ready: true, recovering: false }),
              emit(({ context }) => invalidation(context.input.path)),
            ],
          },
          {
            actions: assign({ ready: true }),
          },
        ],
        'leg.nativeEvent': [
          {
            guard: ({ context, event }) => {
              const absPath = resolveNativeSignalPath(context.input.path, event.filename);
              return absPath !== context.input.path && context.ignored(absPath);
            },
            actions: assign({ retryAttempts: 0 }),
          },
          {
            actions: [
              assign({ retryAttempts: 0 }),
              emit(({ context }) => invalidation(context.input.path)),
            ],
          },
        ],
        'leg.nativeError': [
          {
            guard: ({ context, event }) =>
              context.input.options?.listing === false && event.error.code === 'ENOENT',
            target: 'backoff',
            actions: assign({
              ready: true,
              recovering: true,
              retryDelayMs: LISTING_MISSING_RETRY_MS,
            }),
          },
          {
            guard: ({ event }) => event.error.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
            target: 'chokidar',
            actions: [
              assign({ recovering: false, chokidarDepth: undefined }),
              emit(({ context }) => invalidation(context.input.path)),
            ],
          },
          {
            target: 'backoff',
            actions: [
              assign({
                recovering: true,
                retryDelayMs: ({ context }) =>
                  Math.min(
                    NATIVE_RETRY_BASE_MS * 2 ** context.retryAttempts,
                    NATIVE_RETRY_MAX_MS,
                  ),
                retryAttempts: ({ context }) => context.retryAttempts + 1,
              }),
              ({ context, event }) => context.input.runtime.reportError(event.error),
              emit(({ context }) => invalidation(context.input.path)),
            ],
          },
        ],
      },
    },
    backoff: {
      invoke: {
        src: 'retryLeg',
        input: ({ context }) => ({ runtime: context.input.runtime, delayMs: context.retryDelayMs }),
      },
      on: {
        'leg.retryFired': {
          target: 'native',
        },
      },
    },
  },
});

function invalidation(path: string): WatchEmitted {
  return { type: 'change', change: { path, action: 'modified', kind: 'directory' } };
}

type WatchActorRef = ActorRefFrom<typeof watchMachine>;

interface WatchRootInput {
  readonly runtime: WatchRuntime;
}

interface WatchRootContext {
  readonly runtime: WatchRuntime;
  readonly subscriptions: Readonly<Record<string, WatchActorRef>>;
}

type WatchRootEvent =
  | { type: 'watch.subscribe'; id: string; path: string; options?: WatchOptions }
  | { type: 'watch.unsubscribe'; id: string };

const watchRootMachine = setup({
  types: {
    input: {} as WatchRootInput,
    context: {} as WatchRootContext,
    events: {} as WatchRootEvent,
  },
  actors: { watchMachine },
}).createMachine({
  id: 'watchRoot',
  context: ({ input }) => ({ runtime: input.runtime, subscriptions: {} }),
  on: {
    'watch.subscribe': {
      actions: assign(({ context, event, spawn }) => {
        const ref = spawn('watchMachine', {
          id: event.id,
          input: { path: event.path, options: event.options, runtime: context.runtime },
        });
        return { subscriptions: { ...context.subscriptions, [event.id]: ref } };
      }),
    },
    'watch.unsubscribe': {
      actions: [
        stopChild(({ event }) => event.id),
        assign({
          subscriptions: ({ context, event }) => {
            const next = { ...context.subscriptions };
            delete next[event.id];
            return next;
          },
        }),
      ],
    },
  },
});

type WatchRootActorRef = ActorRefFrom<typeof watchRootMachine>;

class XStateWatchHandle implements WatchHandle {
  readonly ready: Promise<void>;

  private readonly listeners = new Set<(change: WatchChange) => void>();
  private readonly subscriptions: Subscription[] = [];
  private disposed = false;
  private settled = false;
  private settleReady!: () => void;
  private rejectReady!: (error: unknown) => void;

  constructor(
    private readonly root: WatchRootActorRef,
    private readonly id: string,
    private readonly ref: WatchActorRef,
    private readonly toRequestedPath: (path: string) => string,
    private readonly release: () => void,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.settleReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => undefined);
    this.subscriptions.push(
      ref.on('change', (emitted) => {
        const change = { ...emitted.change, path: this.toRequestedPath(emitted.change.path) };
        for (const listener of this.listeners) listener(change);
      }),
      ref.subscribe((snapshot) => this.onSnapshot(snapshot.context)),
    );
    this.onSnapshot(ref.getSnapshot().context);
  }

  onDidChange(listener: (change: WatchChange) => void): WatchSubscription {
    if (this.disposed) return { dispose: () => {} };
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settle();
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.root.send({ type: 'watch.unsubscribe', id: this.id });
    this.release();
    this.listeners.clear();
  }

  private onSnapshot(context: WatchMachineContext): void {
    if (context.failed !== undefined) this.settle(context.failed);
    else if (context.ready) this.settle();
  }

  private settle(error?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    if (error === undefined) this.settleReady();
    else this.rejectReady(error);
  }
}

export interface WatchService {
  watch(path: string, options?: WatchOptions): WatchHandle;
}

export function createWatchService(runtime: WatchRuntime = NODE_WATCH_RUNTIME): WatchService {
  let root: WatchRootActorRef | undefined;
  let nextId = 0;
  return {
    watch(path: string, options?: WatchOptions): WatchHandle {
      if (!isWatchEnabled()) return disabledWatchHandle();
      if (root === undefined) {
        root = createActor(watchRootMachine, { input: { runtime } }).start();
      }
      const actor = root;
      const id = `watch-${nextId++}`;
      const watched = runtime.resolvePath?.(path) ?? path;
      const toRequestedPath = (changed: string): string =>
        watched === path ? changed : requestedPath(watched, path, changed);
      const ignored = options?.ignored;
      actor.send({
        type: 'watch.subscribe',
        id,
        path: watched,
        options:
          ignored === undefined
            ? options
            : { ...options, ignored: (changed) => ignored(toRequestedPath(changed)) },
      });
      const ref = actor.getSnapshot().context.subscriptions[id];
      if (ref === undefined) throw new Error(`watch subscription "${id}" was not started`);
      return new XStateWatchHandle(actor, id, ref, toRequestedPath, () => {
        if (Object.keys(actor.getSnapshot().context.subscriptions).length === 0) {
          actor.stop();
          if (root === actor) root = undefined;
        }
      });
    },
  };
}

const defaultService = createWatchService();

export const WATCH_ENV = 'KIMI_CODE_WATCH';

const TRUE_WATCH_ENV = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WATCH_ENV = new Set(['0', 'false', 'no', 'off']);

let watchEnabledFromConfig = true;

export function setWatchEnabled(enabled: boolean): void {
  watchEnabledFromConfig = enabled;
}

export function isWatchEnabled(): boolean {
  const raw = process.env[WATCH_ENV]?.trim().toLowerCase();
  if (raw !== undefined && raw.length > 0) {
    if (FALSE_WATCH_ENV.has(raw)) return false;
    if (TRUE_WATCH_ENV.has(raw)) return true;
  }
  return watchEnabledFromConfig;
}

function disabledWatchHandle(): WatchHandle {
  return {
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose: () => {} }),
    dispose: () => {},
  };
}

export function watch(path: string, options?: WatchOptions): WatchHandle {
  return defaultService.watch(path, options);
}

export function watchCandidates(
  root: string,
  candidates: readonly string[],
  options?: WatchOptions,
): WatchHandle {
  return new CandidateWatchHandle(root, candidates, options);
}

class CandidateWatchHandle implements WatchHandle {
  readonly ready: Promise<void>;
  private disposed = false;
  private settled = false;
  private planKey = '';
  private readonly handles: WatchHandle[] = [];
  private readonly subscriptions: WatchSubscription[] = [];
  private readonly listeners = new Set<(change: WatchChange) => void>();
  private settleReady!: () => void;
  private rejectReady!: (error: unknown) => void;

  constructor(
    private readonly root: string,
    private readonly candidates: readonly string[],
    private readonly options?: WatchOptions,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.settleReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => undefined);
    void this.rebuild(true);
  }

  onDidChange(listener: (change: WatchChange) => void): WatchSubscription {
    if (this.disposed) return { dispose: () => {} };
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settle();
    this.teardown();
    this.listeners.clear();
  }

  private async rebuild(initial: boolean): Promise<void> {
    if (this.disposed) return;
    const plan = planCandidateWatches(this.root, this.candidates);
    const key = `${plan.notify.join('\0')}\0\0${plan.paths.join('\0')}\0\0${plan.pending.join('\0')}`;
    if (!initial && key === this.planKey) return;
    this.planKey = key;
    this.teardown();
    const next: WatchHandle[] = [];
    for (const path of plan.paths) next.push(watch(path, this.options));
    for (const dir of plan.notify) {
      if (!watchPathExists(dir)) continue;
      next.push(
        watch(dir, {
          ...this.options,
          listing: false,
          recursive: false,
          ignored: (path) =>
            !isCandidateRelated(dir, this.candidates, path) ||
            (this.options?.ignored?.(path) ?? false),
        }),
      );
    }
    for (const path of plan.pending) {
      next.push(watch(path, { ...this.options, listing: false }));
    }
    this.handles.push(...next);
    for (const handle of next) {
      this.subscriptions.push(
        handle.onDidChange((change) => {
          void this.rebuild(false);
          for (const listener of this.listeners) listener(change);
        }),
      );
    }
    try {
      await Promise.all(next.map((handle) => handle.ready));
      this.settle();
    } catch (error) {
      this.settle(error);
    }
  }

  private teardown(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    for (const handle of this.handles) handle.dispose();
    this.handles.length = 0;
  }

  private settle(error?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    if (error === undefined) this.settleReady();
    else this.rejectReady(error);
  }
}

function planCandidateWatches(
  root: string,
  candidates: readonly string[],
): {
  readonly paths: readonly string[];
  readonly notify: readonly string[];
  readonly pending: readonly string[];
} {
  const paths = new Set<string>();
  const notify = new Set<string>();
  const pending = new Set<string>();
  for (const candidate of candidates) {
    if (watchPathExists(candidate)) {
      paths.add(candidate);
      continue;
    }
    let current = dirname(candidate);
    while (!watchPathExists(current) && !sameWatchPath(current, root)) {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (watchPathExists(current) && !isKimiCodeDir(current)) notify.add(current);
    else pending.add(candidate);
  }
  return {
    paths: [...paths].toSorted(),
    notify: [...notify].toSorted(),
    pending: [...pending].toSorted(),
  };
}

function isKimiCodeDir(path: string): boolean {
  const name = basename(path);
  return process.platform === 'win32' ? name.toLowerCase() === '.kimi-code' : name === '.kimi-code';
}

function isCandidateRelated(root: string, candidates: readonly string[], path: string): boolean {
  for (const candidate of candidates) {
    if (sameWatchPath(path, candidate)) return true;
    if (isPathInside(path, candidate) || isPathInside(candidate, path)) return true;
    const segment = firstPathSegment(root, candidate);
    if (segment !== undefined && (basename(path) === segment || path.endsWith(`${sep}${segment}`))) {
      return true;
    }
  }
  return false;
}

function firstPathSegment(root: string, candidate: string): string | undefined {
  const rel = relative(root, candidate);
  if (rel === '' || isOutside(rel)) return undefined;
  return rel.split(/[/\\]/)[0];
}

function isPathInside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel !== '' && !isOutside(rel);
}

function sameWatchPath(left: string, right: string): boolean {
  const a = left.replaceAll('\\', '/').replace(/\/+$/, '');
  const b = right.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function watchPathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function resolveLongPath(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function requestedPath(watched: string, requested: string, changed: string): string {
  const rel = relative(watched, changed);
  if (rel === '') return requested;
  if (isOutside(rel)) return changed;
  return join(requested, rel);
}

function resolveNativeSignalPath(root: string, filename: string | null): string {
  if (filename === null || filename === '' || filename === basename(root)) return root;
  const absPath = isAbsolute(filename) ? filename : join(root, filename);
  const rel = relative(root, absPath);
  if (!isOutside(rel)) return absPath;
  return root;
}

function isOutside(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
