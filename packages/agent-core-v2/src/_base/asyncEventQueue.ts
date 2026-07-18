/**
 * `_base.asyncEventQueue` — push-based async iterable.
 *
 * Bridges a callback-driven producer (e.g. a streaming LLM's `onMessagePart`)
 * to an async-generator consumer. Values pushed while there is a pending
 * `next()` waiter are delivered immediately; otherwise they buffer in-order.
 * `end()` signals normal termination; `fail(err)` terminates with an error
 * that is thrown at the next `next()` (once the buffered values have been
 * drained). Idempotent — repeated `end`/`fail`/`push` after termination are
 * no-ops.
 *
 * Layer L0 substrate — used both by the Agent-scope `llmRequester` (turn
 * driver) and the App-scope `Model.request(...)` god-object stream.
 */

export class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private error: unknown;
  private failed = false;
  private ended = false;

  push(value: T): void {
    if (this.failed || this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  end(): void {
    if (this.failed || this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.failed || this.ended) return;
    this.error = error;
    this.failed = true;
    if (this.values.length > 0) return;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      const value = this.values.shift()!;
      return Promise.resolve({ done: false, value });
    }
    if (this.failed) {
      return Promise.reject(this.error);
    }
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
