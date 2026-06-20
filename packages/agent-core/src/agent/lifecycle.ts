import { createDecorator } from '../di';
import type { IDisposable } from '../di';
import type { PromptOrigin } from './context';

/**
 * Narrowed context passed to `onBeforePrompt` handlers. Handlers may inject a
 * system reminder into the prompt being built; they reach every other service
 * through their own injected dependencies (closed over at registration time),
 * never through this context.
 */
export interface PromptCtx {
  readonly agentId?: string;
  readonly turnId?: number;
  injectSystemReminder(content: string, origin: PromptOrigin): void;
}

/** Context carried by session-scoped lifecycle hooks. */
export interface SessionHookCtx {
  readonly sessionId: string;
}

/** Context carried by agent-scoped lifecycle hooks. */
export interface AgentHookCtx {
  readonly agentId: string;
}

/** Context carried by turn-scoped lifecycle hooks. */
export interface TurnHookCtx {
  readonly turnId?: number;
}

export interface ILifecycleService {
  readonly _serviceBrand: undefined;

  onBeforePrompt(handler: (ctx: PromptCtx) => void | Promise<void>): IDisposable;

  /**
   * Fired when a message is removed from the context (e.g. undo), carrying the
   * index of the removed message so handlers can keep any history-indexed state
   * aligned.
   */
  onContextMessageRemoved(handler: (index: number) => void): IDisposable;

  /** Fired by the framework (turn loop) before a step's prompt is built. */
  fireBeforePrompt(ctx: PromptCtx): Promise<void>;

  /** Fired by the context when a message at `index` is removed. */
  fireContextMessageRemoved(index: number): void;

  // ---- Session lifecycle hooks ----
  onSessionWillStart(handler: SessionHookHandler): IDisposable;
  onSessionDidStart(handler: SessionHookHandler): IDisposable;
  onSessionWillClose(handler: SessionHookHandler): IDisposable;
  onSessionDidClose(handler: SessionHookHandler): IDisposable;
  fireSessionWillStart(ctx: SessionHookCtx): Promise<void>;
  fireSessionDidStart(ctx: SessionHookCtx): Promise<void>;
  fireSessionWillClose(ctx: SessionHookCtx): Promise<void>;
  fireSessionDidClose(ctx: SessionHookCtx): Promise<void>;

  // ---- Agent lifecycle hooks ----
  onAgentWillCreate(handler: AgentHookHandler): IDisposable;
  onAgentDidCreate(handler: AgentHookHandler): IDisposable;
  onAgentWillResume(handler: AgentHookHandler): IDisposable;
  onAgentDidResume(handler: AgentHookHandler): IDisposable;
  onAgentWillDispose(handler: AgentHookHandler): IDisposable;
  fireAgentWillCreate(ctx: AgentHookCtx): Promise<void>;
  fireAgentDidCreate(ctx: AgentHookCtx): Promise<void>;
  fireAgentWillResume(ctx: AgentHookCtx): Promise<void>;
  fireAgentDidResume(ctx: AgentHookCtx): Promise<void>;
  fireAgentWillDispose(ctx: AgentHookCtx): Promise<void>;

  // ---- Turn lifecycle hooks ----
  onTurnWillStart(handler: TurnHookHandler): IDisposable;
  onTurnDidStart(handler: TurnHookHandler): IDisposable;
  onTurnDidEnd(handler: TurnHookHandler): IDisposable;
  fireTurnWillStart(ctx: TurnHookCtx): Promise<void>;
  fireTurnDidStart(ctx: TurnHookCtx): Promise<void>;
  fireTurnDidEnd(ctx: TurnHookCtx): Promise<void>;
}

export const ILifecycleService = createDecorator<ILifecycleService>('lifecycleService');

type BeforePromptHandler = (ctx: PromptCtx) => void | Promise<void>;
type SessionHookHandler = (ctx: SessionHookCtx) => void | Promise<void>;
type AgentHookHandler = (ctx: AgentHookCtx) => void | Promise<void>;
type TurnHookHandler = (ctx: TurnHookCtx) => void | Promise<void>;

export class LifecycleService implements ILifecycleService {
  readonly _serviceBrand: undefined;

  private readonly beforePromptHandlers = new Set<BeforePromptHandler>();
  private readonly contextMessageRemovedHandlers = new Set<(index: number) => void>();

  onBeforePrompt(handler: BeforePromptHandler): IDisposable {
    this.beforePromptHandlers.add(handler);
    return { dispose: () => this.beforePromptHandlers.delete(handler) };
  }

  onContextMessageRemoved(handler: (index: number) => void): IDisposable {
    this.contextMessageRemovedHandlers.add(handler);
    return { dispose: () => this.contextMessageRemovedHandlers.delete(handler) };
  }

  async fireBeforePrompt(ctx: PromptCtx): Promise<void> {
    for (const handler of this.beforePromptHandlers) {
      await handler(ctx);
    }
  }

  fireContextMessageRemoved(index: number): void {
    for (const handler of this.contextMessageRemovedHandlers) {
      handler(index);
    }
  }

  private readonly sessionWillStartHandlers = new Set<SessionHookHandler>();
  private readonly sessionDidStartHandlers = new Set<SessionHookHandler>();
  private readonly sessionWillCloseHandlers = new Set<SessionHookHandler>();
  private readonly sessionDidCloseHandlers = new Set<SessionHookHandler>();

  onSessionWillStart(handler: SessionHookHandler): IDisposable {
    this.sessionWillStartHandlers.add(handler);
    return { dispose: () => this.sessionWillStartHandlers.delete(handler) };
  }

  onSessionDidStart(handler: SessionHookHandler): IDisposable {
    this.sessionDidStartHandlers.add(handler);
    return { dispose: () => this.sessionDidStartHandlers.delete(handler) };
  }

  onSessionWillClose(handler: SessionHookHandler): IDisposable {
    this.sessionWillCloseHandlers.add(handler);
    return { dispose: () => this.sessionWillCloseHandlers.delete(handler) };
  }

  onSessionDidClose(handler: SessionHookHandler): IDisposable {
    this.sessionDidCloseHandlers.add(handler);
    return { dispose: () => this.sessionDidCloseHandlers.delete(handler) };
  }

  async fireSessionWillStart(ctx: SessionHookCtx): Promise<void> {
    for (const handler of this.sessionWillStartHandlers) {
      await handler(ctx);
    }
  }

  async fireSessionDidStart(ctx: SessionHookCtx): Promise<void> {
    for (const handler of this.sessionDidStartHandlers) {
      await handler(ctx);
    }
  }

  async fireSessionWillClose(ctx: SessionHookCtx): Promise<void> {
    for (const handler of this.sessionWillCloseHandlers) {
      await handler(ctx);
    }
  }

  async fireSessionDidClose(ctx: SessionHookCtx): Promise<void> {
    for (const handler of this.sessionDidCloseHandlers) {
      await handler(ctx);
    }
  }

  private readonly agentWillCreateHandlers = new Set<AgentHookHandler>();
  private readonly agentDidCreateHandlers = new Set<AgentHookHandler>();
  private readonly agentWillResumeHandlers = new Set<AgentHookHandler>();
  private readonly agentDidResumeHandlers = new Set<AgentHookHandler>();
  private readonly agentWillDisposeHandlers = new Set<AgentHookHandler>();

  onAgentWillCreate(handler: AgentHookHandler): IDisposable {
    this.agentWillCreateHandlers.add(handler);
    return { dispose: () => this.agentWillCreateHandlers.delete(handler) };
  }

  onAgentDidCreate(handler: AgentHookHandler): IDisposable {
    this.agentDidCreateHandlers.add(handler);
    return { dispose: () => this.agentDidCreateHandlers.delete(handler) };
  }

  onAgentWillResume(handler: AgentHookHandler): IDisposable {
    this.agentWillResumeHandlers.add(handler);
    return { dispose: () => this.agentWillResumeHandlers.delete(handler) };
  }

  onAgentDidResume(handler: AgentHookHandler): IDisposable {
    this.agentDidResumeHandlers.add(handler);
    return { dispose: () => this.agentDidResumeHandlers.delete(handler) };
  }

  onAgentWillDispose(handler: AgentHookHandler): IDisposable {
    this.agentWillDisposeHandlers.add(handler);
    return { dispose: () => this.agentWillDisposeHandlers.delete(handler) };
  }

  async fireAgentWillCreate(ctx: AgentHookCtx): Promise<void> {
    for (const handler of this.agentWillCreateHandlers) {
      await handler(ctx);
    }
  }

  async fireAgentDidCreate(ctx: AgentHookCtx): Promise<void> {
    for (const handler of this.agentDidCreateHandlers) {
      await handler(ctx);
    }
  }

  async fireAgentWillResume(ctx: AgentHookCtx): Promise<void> {
    for (const handler of this.agentWillResumeHandlers) {
      await handler(ctx);
    }
  }

  async fireAgentDidResume(ctx: AgentHookCtx): Promise<void> {
    for (const handler of this.agentDidResumeHandlers) {
      await handler(ctx);
    }
  }

  async fireAgentWillDispose(ctx: AgentHookCtx): Promise<void> {
    for (const handler of this.agentWillDisposeHandlers) {
      await handler(ctx);
    }
  }

  private readonly turnWillStartHandlers = new Set<TurnHookHandler>();
  private readonly turnDidStartHandlers = new Set<TurnHookHandler>();
  private readonly turnDidEndHandlers = new Set<TurnHookHandler>();

  onTurnWillStart(handler: TurnHookHandler): IDisposable {
    this.turnWillStartHandlers.add(handler);
    return { dispose: () => this.turnWillStartHandlers.delete(handler) };
  }

  onTurnDidStart(handler: TurnHookHandler): IDisposable {
    this.turnDidStartHandlers.add(handler);
    return { dispose: () => this.turnDidStartHandlers.delete(handler) };
  }

  onTurnDidEnd(handler: TurnHookHandler): IDisposable {
    this.turnDidEndHandlers.add(handler);
    return { dispose: () => this.turnDidEndHandlers.delete(handler) };
  }

  async fireTurnWillStart(ctx: TurnHookCtx): Promise<void> {
    for (const handler of this.turnWillStartHandlers) {
      await handler(ctx);
    }
  }

  async fireTurnDidStart(ctx: TurnHookCtx): Promise<void> {
    for (const handler of this.turnDidStartHandlers) {
      await handler(ctx);
    }
  }

  async fireTurnDidEnd(ctx: TurnHookCtx): Promise<void> {
    for (const handler of this.turnDidEndHandlers) {
      await handler(ctx);
    }
  }
}
