import { AgentModelRef } from "@moonshot-ai/agent-core";
import { shallowRef, type ShallowRef } from "@moonshot-ai/agent-core/kernel/index";
import {
  InteractionRef,
  PermissionRef,
  PlanRef,
  openInteractions,
  type InteractionEvent,
  type Interactions,
} from "@moonshot-ai/harness-core";
import type { KimiSession } from "@moonshot-ai/kimi-code-sdk";
import { vi } from "vitest";

export interface FakeAgentCall {
  readonly message: unknown;
  readonly meta?: Record<string, unknown>;
}

export class FakeAgentHandle {
  readonly agentId: string;
  readonly config = undefined;
  readonly submitted: FakeAgentCall[] = [];
  readonly steered: Array<string | readonly string[]> = [];
  readonly cancelled: string[] = [];
  readonly facades = new Map<unknown, unknown>();
  abortCount = 0;
  submitError: Error | undefined;

  private readonly listeners = new Map<string, Set<(event: never) => void>>();

  constructor(agentId = "main") {
    this.agentId = agentId;
  }

  on(type: string, handler: (event: never) => void): { unsubscribe(): void } {
    let handlers = this.listeners.get(type);
    if (handlers === undefined) {
      handlers = new Set();
      this.listeners.set(type, handlers);
    }
    handlers.add(handler);
    return { unsubscribe: () => handlers?.delete(handler) };
  }

  emit(event: { readonly type: string } & Record<string, unknown>): void {
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) {
      handler(event as never);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  submit(message: unknown, meta?: Record<string, unknown>): { type: string } {
    this.submitted.push({ message, meta });
    if (this.submitError !== undefined) {
      const error = this.submitError;
      this.submitError = undefined;
      throw error;
    }
    return { type: "prompt.submitted" };
  }

  steer(ids: string | readonly string[]): { type: string } {
    this.steered.push(ids);
    return { type: "prompt.steered" };
  }

  cancel(id: string): { type: string } {
    this.cancelled.push(id);
    return { type: "prompt.cancelled" };
  }

  abort(): { type: string } {
    this.abortCount += 1;
    return { type: "agent.aborted" };
  }

  resolve(token: unknown): unknown {
    return this.facades.get(token);
  }
}

export interface FakeModelFacade {
  readonly current: ShallowRef<{ alias: string | null; thinking: string | null }>;
  readonly setModels: string[];
  readonly setThinkingEfforts: string[];
}

export function createFakeModelFacade(): FakeModelFacade & {
  setModel(alias: string): Promise<void>;
  setThinking(effort: string): Promise<void>;
} {
  const current = shallowRef<{ alias: string | null; thinking: string | null }>({
    alias: null,
    thinking: null,
  });
  const setModels: string[] = [];
  const setThinkingEfforts: string[] = [];
  return {
    current,
    setModels,
    setThinkingEfforts,
    setModel: async (alias: string) => {
      setModels.push(alias);
      current.value = { ...current.value, alias };
    },
    setThinking: async (effort: string) => {
      setThinkingEfforts.push(effort);
      current.value = { ...current.value, thinking: effort };
    },
  };
}

export interface FakePermissionFacade {
  readonly state: ShallowRef<{ mode: string }>;
  readonly modes: string[];
}

export function createFakePermissionFacade(initial = "manual"): FakePermissionFacade & {
  mode(): string;
  setMode(mode: string): Promise<void>;
  setModeAndBroadcast(mode: string): Promise<void>;
} {
  const state = shallowRef({ mode: initial });
  const modes: string[] = [];
  const apply = async (mode: string): Promise<void> => {
    modes.push(mode);
    state.value = { mode };
  };
  return {
    state,
    modes,
    mode: () => state.value.mode,
    setMode: apply,
    setModeAndBroadcast: apply,
  };
}

export function createFakePlanFacade(active = false): {
  readonly state: ShallowRef<{ active: boolean }>;
  readonly enters: number[];
  readonly cancels: number[];
  enter(): Promise<void>;
  cancel(): Promise<void>;
  clear(): Promise<void>;
  status(): Promise<null>;
} {
  const state = shallowRef({ active });
  const enters: number[] = [];
  const cancels: number[] = [];
  return {
    state,
    enters,
    cancels,
    enter: async () => {
      enters.push(1);
      state.value = { active: true };
    },
    cancel: async () => {
      cancels.push(1);
      state.value = { active: false };
    },
    clear: async () => undefined,
    status: async () => null,
  };
}

export interface FakeEngineSession {
  readonly session: KimiSession;
  readonly main: FakeAgentHandle;
  readonly interactions: Interactions;
  readonly history: unknown[];
  readonly dispatch: ReturnType<typeof vi.fn>;
  readonly model: FakeModelFacade;
  readonly permission: FakePermissionFacade;
  readonly plan: ReturnType<typeof createFakePlanFacade>;
  emitAgent(event: { readonly type: string } & Record<string, unknown>): void;
  emitHandle(type: string, event: Record<string, unknown>): void;
  commitSession(event: Record<string, unknown>): void;
  rosterSource(agentId: string, source: string): void;
  closeCount(): number;
}

export function createFakeEngineSession(id = "session-1"): FakeEngineSession {
  const main = new FakeAgentHandle("main");
  const model = createFakeModelFacade();
  const permission = createFakePermissionFacade();
  const plan = createFakePlanFacade();
  main.facades.set(AgentModelRef, model);
  main.facades.set(PermissionRef, permission);
  main.facades.set(PlanRef, plan);

  const handleListeners = new Map<string, Set<(event: never) => void>>();
  const commitListeners = new Set<(entry: { event: Record<string, unknown> }, state: unknown) => void>();
  const history: unknown[] = [];
  const roster: Record<string, { source?: string }> = { main: {} };
  const dispatch = vi.fn(async (event: { type: string; message?: unknown }) => {
    if (event.type === "message.appended") history.push(event.message);
    return {};
  });
  const emitHandle = (type: string, event: Record<string, unknown>): void => {
    for (const handler of [...(handleListeners.get(type) ?? [])]) {
      handler(event as never);
    }
  };
  const interactions = openInteractions({
    fire: (event: InteractionEvent) => emitHandle(event.type, event as unknown as Record<string, unknown>),
  });
  let closes = 0;

  const handle = {
    on(featureOrType: unknown, maybeType: unknown, maybeHandler?: (event: never) => void) {
      const type = typeof featureOrType === "string" ? featureOrType : (maybeType as string);
      const handler = typeof featureOrType === "string" ? (maybeType as (event: never) => void) : maybeHandler!;
      let handlers = handleListeners.get(type);
      if (handlers === undefined) {
        handlers = new Set();
        handleListeners.set(type, handlers);
      }
      handlers.add(handler);
      return () => handlers?.delete(handler);
    },
    resolve(token: unknown) {
      if (token === InteractionRef) return interactions;
      return undefined;
    },
    get: () => undefined,
    create: vi.fn(),
    close: vi.fn(async () => undefined),
    stores: {
      session: {
        onCommit(listener: (entry: { event: Record<string, unknown> }, state: unknown) => void) {
          commitListeners.add(listener);
          return () => commitListeners.delete(listener);
        },
        getState: () => ({ roster: { agents: roster } }),
        dispatch: vi.fn(async () => ({})),
      },
      get: (agentId: string) =>
        agentId === "main"
          ? {
              getState: () => ({
                history,
                queue: [],
                notifications: [],
                reminders: [],
                turnIndex: { nextTurnId: 1 },
              }),
              dispatch,
            }
          : undefined,
      flush: vi.fn(async () => undefined),
    },
  };

  const session = {
    id,
    handle,
    main,
    close: async () => {
      closes += 1;
    },
  } as unknown as KimiSession;

  return {
    session,
    main,
    interactions,
    history,
    dispatch,
    model: model as FakeModelFacade,
    permission: permission as FakePermissionFacade,
    plan,
    emitAgent: (event) => main.emit(event),
    emitHandle,
    commitSession: (event) => {
      for (const listener of [...commitListeners]) {
        listener({ event }, handle.stores.session.getState());
      }
    },
    rosterSource: (agentId, source) => {
      roster[agentId] = { source };
    },
    closeCount: () => closes,
  };
}
