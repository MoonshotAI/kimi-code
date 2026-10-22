import { createActor, waitFor } from 'xstate';

import type { HistoryMessage, UserEntry } from '#/history/message';
import type { ToolDescription } from '#/llm/message';
import { createPolicyRegistry, type PolicyRegistry } from '#/llm/policy/registry';
import type { ToolExecutor } from '#/tool/index';
import { waitEvent, type WaitOpts } from '#/utils/wait';
import { commandError, inputError, type LoopCommand, type LoopInput } from './contract/command';
import type { LoopAck, LoopEmitted } from './contract/emitted';
import type { HookRegistration } from './contract/hook';
import type { RemindEntry } from './contract/inbox';
import type { TurnOutcome } from './contract/outcome';
import { createHookRegistry, type HookRegistry } from './hook/registry';
import { createLoopMachine } from './machine/loop';
import type { LoopLlmRequester } from './machine/request-actor';
import { createLoopRequester } from './requester';
import { createLoopState, viewOf, type LoopState, type LoopStateEvent, type LoopStateOutput } from './state';
import { createWaitForTasks, type WaitForTasks } from './tool/tasks';

export interface CreateLoopOptions {
  readonly requester?: LoopLlmRequester;
  readonly executor: ToolExecutor;
  readonly hooks?: readonly HookRegistration[];
  readonly input?: LoopInput;
  readonly abortGraceMs?: number;
  readonly onListenerError?: (error: unknown, event: LoopEmitted) => void;
}

export interface Loop {
  readonly state: LoopState;
  readonly baseRequester: LoopLlmRequester | undefined;
  readonly requester: LoopLlmRequester;
  readonly executor: ToolExecutor;
  readonly waitForTasks: WaitForTasks;
  readonly hooks: HookRegistry;
  readonly policy: PolicyRegistry;
  submit(entry: UserEntry): LoopAck<'prompt.submitted'> | undefined;
  notify(entry: UserEntry): LoopAck<'prompt.notified'> | undefined;
  remind(entry: RemindEntry): LoopAck<'prompt.reminded'> | undefined;
  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> | undefined;
  cancel(promptId: string): LoopAck<'prompt.canceled'> | undefined;
  continue(): void;
  abort(reason?: unknown): void;
  abortTool(toolCallId: string, reason?: unknown): void;
  detachTool(toolCallId: string): void;
  setRequester(requester: LoopLlmRequester | undefined): void;
  setContext(messages: HistoryMessage[], reason?: string): LoopAck<'context.settled' | 'context.rejected'> | undefined;
  setSystemPrompt(systemPrompt: string): LoopAck<'system_prompt.settled'> | undefined;
  setTools(tools: readonly ToolDescription[]): LoopAck<'tools.settled'> | undefined;
  subscribe(listener: (event: LoopEmitted) => void): () => void;
  wait<T extends LoopEmitted['type']>(type: T, opts?: WaitOpts<LoopAck<T>>): Promise<LoopAck<T>>;
  runTurn(entry: UserEntry, opts?: { readonly signal?: AbortSignal }): Promise<TurnOutcome>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

export function createLoop({ input = {}, hooks, onListenerError, ...options }: CreateLoopOptions): Loop {
  const invalid = inputError(input);
  if (invalid !== undefined) throw new TypeError(invalid);
  const registry = createHookRegistry();
  for (const registration of hooks ?? []) registry.add(registration);
  const policy = createPolicyRegistry();
  let baseRequester = options.requester;
  const requester = (): LoopLlmRequester => {
    const base = baseRequester;
    if (base === undefined) throw new Error('loop has no requester');
    return base.with({ policy: policy.asPolicy() });
  };
  const state = createLoopState(input);
  const actor = createActor(createLoopMachine({ ...options, requester, hooks: registry }));
  const listeners = new Set<(event: LoopEmitted) => void>();
  const outputs: LoopStateOutput[] = [];
  let flushing = false;
  let processing = false;
  const flush = (): void => {
    if (flushing || processing) return;
    flushing = true;
    try {
      for (let output = outputs.shift(); output !== undefined; output = outputs.shift()) {
        if (output.type === 'signal') actor.send(output.signal);
        else for (const listener of Array.from(listeners)) listener(output.event);
      }
    } finally {
      flushing = false;
    }
  };
  state.on('*', (output) => {
    outputs.push(output);
  });
  actor.on('*', (fact) => {
    processing = true;
    state.send({ type: 'fact', fact });
  });
  actor.subscribe(() => {
    processing = false;
    flush();
  });
  registry.attach((event) => actor.send({ type: 'hook.changed', event }));
  actor.start();

  const open = (): boolean => state.getSnapshot().context.phase !== 'closed' && actor.getSnapshot().status === 'active';
  const check = (command: LoopCommand): void => {
    const reason = commandError(command);
    if (reason !== undefined) throw new TypeError(reason);
  };
  const send = (event: LoopStateEvent): void => {
    state.send(event);
    flush();
  };
  const acknowledge = <A>(command: LoopCommand, create: (reply: (ack: A) => void) => LoopStateEvent): A | undefined => {
    check(command);
    if (!open()) return undefined;
    let ack: A | undefined;
    send(
      create((event) => {
        ack = event;
      }),
    );
    return ack;
  };
  const abort = (reason?: unknown): void => {
    if (open()) send({ type: 'abort', reason });
  };
  const subscribe = (listener: (event: LoopEmitted) => void): (() => void) => {
    const deliver = (event: LoopEmitted): void => {
      try {
        listener(event);
      } catch (error) {
        if (onListenerError === undefined) throw error;
        onListenerError(error, event);
      }
    };
    listeners.add(deliver);
    return () => {
      listeners.delete(deliver);
    };
  };
  const wait = <T extends LoopEmitted['type']>(type: T, opts?: WaitOpts<LoopAck<T>>): Promise<LoopAck<T>> =>
    waitEvent<LoopAck<T>>(
      (handler) =>
        subscribe((event) => {
          if (event.type === type) handler(event as LoopAck<T>);
        }),
      opts,
    );
  return {
    get state(): LoopState {
      return viewOf(state.getSnapshot().context);
    },
    requester: createLoopRequester(requester, () => state.getSnapshot().context.durable.messages),
    get baseRequester(): LoopLlmRequester | undefined {
      return baseRequester;
    },
    executor: options.executor,
    waitForTasks: createWaitForTasks(actor),
    hooks: {
      add: (registration) => registry.add(registration),
      pause: (id) => registry.pause(id),
      resume: (id) => registry.resume(id),
      remove: (id) => registry.remove(id),
      list: () => registry.list(),
    },
    policy,
    submit: (entry) =>
      acknowledge<LoopAck<'prompt.submitted'>>({ type: 'input.submit', entry }, (reply) => ({
        type: 'submit',
        entry,
        reply,
      })),
    notify: (entry) =>
      acknowledge<LoopAck<'prompt.notified'>>({ type: 'input.notify', entry }, (reply) => ({
        type: 'notify',
        entry,
        reply,
      })),
    remind: (entry) =>
      acknowledge<LoopAck<'prompt.reminded'>>({ type: 'input.remind', entry }, (reply) => ({
        type: 'remind',
        entry,
        reply,
      })),
    steer: (promptIds) =>
      acknowledge<LoopAck<'prompt.steered'>>({ type: 'input.steer', promptIds }, (reply) => ({
        type: 'steer',
        promptIds,
        reply,
      })),
    cancel: (promptId) =>
      acknowledge<LoopAck<'prompt.canceled'>>({ type: 'input.cancel', promptId }, (reply) => ({
        type: 'cancel',
        promptId,
        reply,
      })),
    continue: () => {
      if (open()) send({ type: 'continue' });
    },
    abort,
    abortTool: (toolCallId, reason) => {
      check({ type: 'input.abort_tool', toolCallId });
      if (open()) send({ type: 'abortTool', toolCallId, reason });
    },
    detachTool: (toolCallId) => {
      check({ type: 'input.detach_tool', toolCallId });
      if (open()) send({ type: 'detachTool', toolCallId });
    },
    setRequester: (next) => {
      if (open()) baseRequester = next;
    },
    setContext: (messages, reason) =>
      acknowledge<LoopAck<'context.settled' | 'context.rejected'>>(
        { type: 'input.set_context', messages },
        (reply) => ({ type: 'setContext', messages, reason, reply }),
      ),
    setSystemPrompt: (systemPrompt) =>
      acknowledge<LoopAck<'system_prompt.settled'>>({ type: 'input.set_system_prompt', systemPrompt }, (reply) => ({
        type: 'setSystemPrompt',
        systemPrompt,
        reply,
      })),
    setTools: (tools) =>
      acknowledge<LoopAck<'tools.settled'>>({ type: 'input.set_tools', tools }, (reply) => ({
        type: 'setTools',
        tools,
        reply,
      })),
    subscribe,
    wait,
    runTurn: (entry, opts) =>
      new Promise((resolve, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) {
          resolve({ type: 'aborted', reason: signal.reason });
          return;
        }
        check({ type: 'input.run_turn', entry });
        const onAbort = (): void => {
          abort(signal?.reason);
        };
        const reply = (outcome?: TurnOutcome): void => {
          signal?.removeEventListener('abort', onAbort);
          if (outcome === undefined) reject(new Error('runTurn is only accepted while idle'));
          else resolve(outcome);
        };
        if (!open()) {
          reply();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        send({ type: 'runTurn', entry, reply });
      }),
    waitForIdle: async () => {
      await waitFor(
        actor,
        (snapshot) => snapshot.status !== 'active' || state.getSnapshot().context.phase !== 'running',
      );
    },
    close: async () => {
      if (open()) {
        send({ type: 'close' });
        await waitFor(actor, (snapshot) => snapshot.status !== 'active').catch(() => {});
      }
      actor.stop();
    },
  };
}
