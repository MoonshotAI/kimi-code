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
}

export const ILifecycleService = createDecorator<ILifecycleService>('lifecycleService');

type BeforePromptHandler = (ctx: PromptCtx) => void | Promise<void>;

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
}
