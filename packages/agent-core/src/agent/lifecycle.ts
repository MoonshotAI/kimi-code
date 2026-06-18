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
  readonly turnId: number;
  injectSystemReminder(content: string, origin: PromptOrigin): void;
}

export interface ILifecycleService {
  readonly _serviceBrand: undefined;

  onBeforePrompt(handler: (ctx: PromptCtx) => void | Promise<void>): IDisposable;

  /** Fired by the framework (turn loop) before a step's prompt is built. */
  fireBeforePrompt(ctx: PromptCtx): Promise<void>;
}

export const ILifecycleService = createDecorator<ILifecycleService>('lifecycleService');

type BeforePromptHandler = (ctx: PromptCtx) => void | Promise<void>;

export class LifecycleService implements ILifecycleService {
  readonly _serviceBrand: undefined;

  private readonly beforePromptHandlers = new Set<BeforePromptHandler>();

  onBeforePrompt(handler: BeforePromptHandler): IDisposable {
    this.beforePromptHandlers.add(handler);
    return { dispose: () => this.beforePromptHandlers.delete(handler) };
  }

  async fireBeforePrompt(ctx: PromptCtx): Promise<void> {
    for (const handler of this.beforePromptHandlers) {
      await handler(ctx);
    }
  }
}
