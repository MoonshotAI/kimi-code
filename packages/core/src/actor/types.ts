import type { WaitOpts } from '#/utils/wait';

export interface ActorEvent {
  readonly type: string;
}

export type EventOf<TEvent extends ActorEvent, K extends TEvent['type']> = Extract<TEvent, { readonly type: K }>;

export interface StepControl<TState, TEvent extends ActorEvent = never, R = void> {
  readonly signal: AbortSignal;
  readonly done: Promise<R>;
  resolve(value: R): void;
  reject(error: unknown): void;
  after(delayMs: number, fn: (control: ActorControl<TState, TEvent>) => void): () => void;
  bind<Args extends unknown[]>(
    fn: (control: ActorControl<TState, TEvent>, ...args: Args) => void,
  ): (...args: Args) => void;
  onCancel(
    handler: (control: ActorControl<TState, TEvent>, reason: unknown, count: number) => void,
  ): void;
  onExit(cleanup: () => void): void;
}

export interface ProcessHandle {
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  readonly cancelReason: unknown;
  readonly cancelCount: number;
  readonly active: boolean;
  readonly done: Promise<void>;
  cancel(reason?: unknown): void;
}

export interface ActorControl<TState, TEvent extends ActorEvent = never> {
  readonly state: TState;
  readonly rootSignal: AbortSignal;
  setState(next: TState): void;
  emit<E extends TEvent>(event: E): E;
  defer(fn: (control: ActorControl<TState, TEvent>) => void): void;
  bind<Args extends unknown[]>(
    fn: (control: ActorControl<TState, TEvent>, ...args: Args) => void,
  ): (...args: Args) => void;
  afterDeliver(fn: () => void): void;
  spawn(runner: (proc: ProcessControl<TState, TEvent>) => Promise<void>): ProcessHandle;
}

export interface ProcessControl<TState, TEvent extends ActorEvent = never>
  extends ActorControl<TState, TEvent> {
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  readonly cancelReason: unknown;
  readonly cancelCount: number;
  checkpoint(): void;
  waitUntil(predicate: () => boolean): Promise<void>;
  step<R>(
    task: (
      signal: AbortSignal,
      step: StepControl<TState, TEvent, NoInfer<R>>,
      control: ActorControl<TState, TEvent>,
    ) => Promise<R> | R,
  ): Promise<R>;
  step<R>(
    nextState: TState,
    task: (
      signal: AbortSignal,
      step: StepControl<TState, TEvent, NoInfer<R>>,
      control: ActorControl<TState, TEvent>,
    ) => Promise<R> | R,
  ): Promise<R>;
}

export interface ActorOptions<TState, TEvent extends ActorEvent = never> {
  readonly initial: TState;
  onEmit?(event: TEvent): void;
  onSchedule?(control: ActorControl<TState, TEvent>): void;
  onIdle?(control: ActorControl<TState, TEvent>): void;
  onError?(control: ActorControl<TState, TEvent>, error: unknown): void;
  onClose?(control: ActorControl<TState, TEvent>): Promise<void> | void;
  onListenerError?(error: unknown, event: TEvent): void;
  isIdle?(state: TState): boolean;
}

export interface Actor<TState, TEvent extends ActorEvent = never> {
  readonly state: TState;
  readonly closing: boolean;
  readonly closed: boolean;
  act<R>(fn: (control: ActorControl<TState, TEvent>) => R): R;
  bind<Args extends unknown[]>(
    fn: (control: ActorControl<TState, TEvent>, ...args: Args) => void,
  ): (...args: Args) => void;
  subscribe(listener: (event: TEvent) => void): () => void;
  wait<K extends TEvent['type']>(
    type: K,
    opts?: WaitOpts<EventOf<TEvent, K>>,
  ): Promise<EventOf<TEvent, K>>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}
