import { createActor, waitFor } from 'xstate';

import type { HistoryMessage, UserEntry } from '#/history/message';
import type { ToolCall, ToolDescription } from '#/llm/message';
import type { ToolExecutor } from '#/tool/index';
import { waitEvent, type WaitOpts } from '#/utils/wait';
import { commandError, inputError, type LoopCommand, type LoopInput, type LoopProfile } from './contract/command';
import type { LoopAck, LoopEmitted } from './contract/emitted';
import type { HookRegistration } from './contract/hook';
import type { Inbox, RemindEntry, TurnTrigger } from './contract/inbox';
import type { TurnOutcome } from './contract/outcome';
import { createHookRegistry, type HookRegistry } from './hook/registry';
import { createLoopMachine } from './machine/loop';
import type { LoopLlmRequester } from './machine/request-actor';
import { createLoopRequester } from './requester';
import { createWaitForTasks, type WaitForTasks } from './tool/tasks';

export interface CreateLoopOptions {
  readonly requester: () => LoopLlmRequester;
  readonly executor: ToolExecutor;
  readonly hooks?: readonly HookRegistration[];
  readonly input?: LoopInput;
  readonly abortGraceMs?: number;
  readonly onListenerError?: (error: unknown, event: LoopEmitted) => void;
}

export interface LoopTurnState {
  readonly id: number;
  readonly trigger: TurnTrigger;
  readonly step: number;
}

export interface LoopToolState {
  readonly toolCall: ToolCall;
  readonly turnId: number;
  readonly detached: boolean;
}

export interface LoopState {
  readonly profile: LoopProfile;
  readonly status: 'idle' | 'running' | 'interrupted';
  readonly held: boolean;
  readonly messages: readonly HistoryMessage[];
  readonly inbox: Readonly<Inbox>;
  readonly nextTurnId: number;
  readonly turn?: LoopTurnState;
  readonly tools: readonly LoopToolState[];
}

export interface Loop {
  readonly state: LoopState;
  readonly requester: LoopLlmRequester;
  readonly executor: ToolExecutor;
  readonly waitForTasks: WaitForTasks;
  readonly hooks: HookRegistry;
  submit(entry: UserEntry): LoopAck<'prompt.submitted'> | undefined;
  notify(entry: UserEntry): LoopAck<'prompt.notified'> | undefined;
  remind(entry: RemindEntry): LoopAck<'prompt.reminded'> | undefined;
  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> | undefined;
  cancel(promptId: string): LoopAck<'prompt.canceled'> | undefined;
  continue(): void;
  abort(reason?: unknown): void;
  abortTool(toolCallId: string, reason?: unknown): void;
  detachTool(toolCallId: string): void;
  setContext(messages: HistoryMessage[], reason?: string): LoopAck<'context.settled' | 'context.rejected'> | undefined;
  setSystemPrompt(systemPrompt?: string): LoopAck<'system_prompt.settled' | 'system_prompt.rejected'> | undefined;
  setTools(tools: readonly ToolDescription[]): LoopAck<'tools.settled' | 'tools.rejected'> | undefined;
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
  const actor = createActor(createLoopMachine({ ...options, hooks: registry }), { input });
  registry.attach((event) => actor.send({ type: 'hook.changed', event }));
  actor.start();
  const dispatch = (command: LoopCommand): boolean => {
    const reason = commandError(command);
    if (reason !== undefined) throw new TypeError(reason);
    if (actor.getSnapshot().status !== 'active') return false;
    actor.send(command);
    return true;
  };
  const acknowledge = <T extends LoopEmitted['type']>(
    create: (reply: (event: LoopAck<T>) => void) => LoopCommand,
  ): LoopAck<T> | undefined => {
    let ack: LoopAck<T> | undefined;
    const command = create((event) => {
      ack = event;
    });
    if (!dispatch(command)) return undefined;
    if (ack === undefined) throw new Error(`loop accepted ${command.type} but produced no ack`);
    return ack;
  };
  const subscribe = (listener: (event: LoopEmitted) => void): (() => void) => {
    const subscription = actor.on('*', (event: LoopEmitted) => {
      try {
        listener(event);
      } catch (error) {
        if (onListenerError === undefined) throw error;
        onListenerError(error, event);
      }
    });
    return () => subscription.unsubscribe();
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
      const snapshot = actor.getSnapshot();
      const { held, messages, inbox, nextTurnId, unfinished, turn, tools, profile } = snapshot.context;
      const current =
        turn !== undefined
          ? { id: turn.id, trigger: turn.trigger, step: turn.step }
          : unfinished !== undefined
            ? { id: unfinished.turnId, trigger: unfinished.trigger, step: unfinished.step }
            : undefined;
      return {
        profile,
        status: snapshot.matches('running') ? 'running' : snapshot.matches('interrupted') ? 'interrupted' : 'idle',
        held,
        messages,
        inbox,
        nextTurnId,
        ...(current === undefined ? {} : { turn: current }),
        tools: Object.values(tools).map(({ toolCall, turnId, detached }) => ({ toolCall, turnId, detached })),
      };
    },
    requester: createLoopRequester(options.requester, () => actor.getSnapshot().context.messages),
    executor: options.executor,
    waitForTasks: createWaitForTasks(actor),
    hooks: {
      add: (registration) => registry.add(registration),
      pause: (id) => registry.pause(id),
      resume: (id) => registry.resume(id),
      remove: (id) => registry.remove(id),
      list: () => registry.list(),
    },
    submit: (entry) => acknowledge<'prompt.submitted'>((reply) => ({ type: 'input.submit', entry, reply })),
    notify: (entry) => acknowledge<'prompt.notified'>((reply) => ({ type: 'input.notify', entry, reply })),
    remind: (entry) => acknowledge<'prompt.reminded'>((reply) => ({ type: 'input.remind', entry, reply })),
    steer: (promptIds) => acknowledge<'prompt.steered'>((reply) => ({ type: 'input.steer', promptIds, reply })),
    cancel: (promptId) => acknowledge<'prompt.canceled'>((reply) => ({ type: 'input.cancel', promptId, reply })),
    continue: () => {
      dispatch({ type: 'input.continue' });
    },
    abort: (reason) => {
      dispatch({ type: 'input.abort_turn', reason });
    },
    abortTool: (toolCallId, reason) => {
      dispatch({ type: 'input.abort_tool', toolCallId, reason });
    },
    detachTool: (toolCallId) => {
      dispatch({ type: 'input.detach_tool', toolCallId });
    },
    setContext: (messages, reason) =>
      acknowledge<'context.settled' | 'context.rejected'>((reply) => ({
        type: 'input.set_context',
        messages,
        reason,
        reply,
      })),
    setSystemPrompt: (systemPrompt) =>
      acknowledge<'system_prompt.settled' | 'system_prompt.rejected'>((reply) => ({
        type: 'input.set_system_prompt',
        systemPrompt,
        reply,
      })),
    setTools: (tools) =>
      acknowledge<'tools.settled' | 'tools.rejected'>((reply) => ({ type: 'input.set_tools', tools, reply })),
    subscribe,
    wait,
    runTurn: (entry, opts) =>
      new Promise((resolve, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) {
          resolve({ type: 'aborted', reason: signal.reason });
          return;
        }
        let settled = false;
        const onAbort = (): void => {
          dispatch({ type: 'input.abort_turn', reason: signal?.reason });
        };
        const reply = (outcome?: TurnOutcome) => {
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          if (outcome === undefined) reject(new Error('runTurn is only accepted while idle'));
          else resolve(outcome);
        };
        if (!dispatch({ type: 'input.run_turn', entry, reply })) reply();
        if (!settled) signal?.addEventListener('abort', onAbort, { once: true });
      }),
    waitForIdle: async () => {
      await waitFor(actor, (snapshot) => snapshot.status !== 'active' || !snapshot.matches('running'));
    },
    close: async () => {
      if (actor.getSnapshot().status === 'active') {
        dispatch({ type: 'input.close' });
        await waitFor(actor, (snapshot) => snapshot.status !== 'active').catch(() => {});
      }
      actor.stop();
    },
  };
}
