import { toDisposable, type IDisposable } from "#/_base/di";

export type Hooks<TEvents extends Record<string, unknown>> = {
  readonly [K in keyof TEvents]: HookSlot<TEvents[K]>;
};

export interface HookSlot<TContext> {
  register(
    id: string,
    handler: HookHandler<TContext>,
    options?: HookRegisterOptions,
  ): IDisposable;

  delete(id: string): boolean;
}

export type HookHandler<TContext> = (
  context: TContext,
  next: () => Promise<void>,
) => void | Promise<void>;

export interface HookRegisterOptions {
  before?: string;
  after?: string;
}

interface HookEntry<TContext> {
  readonly id: string;
  readonly handler: HookHandler<TContext>;
}

export class OrderedHookSlot<TContext> implements HookSlot<TContext> {
  private entries: HookEntry<TContext>[] = [];

  register(
    id: string,
    handler: HookHandler<TContext>,
    options: HookRegisterOptions = {},
  ): IDisposable {
    if (options.before !== undefined && options.after !== undefined) {
      throw new Error('Hook registration cannot specify both before and after');
    }

    this.delete(id);
    const entry = { id, handler };
    const target = options.before ?? options.after;
    if (target === undefined) {
      this.entries.push(entry);
      return this.toEntryDisposable(entry);
    }

    const targetIndex = this.entries.findIndex((item) => item.id === target);
    if (targetIndex < 0) {
      throw new Error(`Hook target "${target}" is not registered`);
    }

    const insertAt = options.before !== undefined ? targetIndex : targetIndex + 1;
    this.entries.splice(insertAt, 0, entry);
    return this.toEntryDisposable(entry);
  }

  delete(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  asDisposable(id: string): IDisposable {
    return toDisposable(() => {
      this.delete(id);
    });
  }

  private toEntryDisposable(entry: HookEntry<TContext>): IDisposable {
    return toDisposable(() => {
      const index = this.entries.indexOf(entry);
      if (index < 0) return;
      this.entries.splice(index, 1);
    });
  }

  async run(context: TContext, terminal: () => Promise<void> = async () => {}): Promise<void> {
    const entries = [...this.entries];
    let index = -1;
    const dispatch = async (nextIndex: number): Promise<void> => {
      if (nextIndex <= index) {
        throw new Error('Hook next() cannot be called more than once');
      }
      index = nextIndex;
      const entry = entries[nextIndex];
      if (entry === undefined) {
        await terminal();
        return;
      }
      await entry.handler(context, () => dispatch(nextIndex + 1));
    };
    await dispatch(0);
  }
}

export function createHooks<TEvents extends Record<string, unknown>, TKeys extends keyof TEvents>(
  keys: readonly TKeys[],
): Hooks<TEvents> {
  return Object.fromEntries(
    keys.map((key) => [key, new OrderedHookSlot<TEvents[TKeys]>()]),
  ) as unknown as Hooks<TEvents>;
}
