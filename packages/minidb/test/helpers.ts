// test/helpers.ts
//
// Shared test plumbing for the minidb suites: temp dirs plus the deterministic
// fault-injection barrier facility (review #28). A barrier replaces the old
// "patch a method, then gamble on setImmediate/sleep interleavings" pattern
// with a programmable hook: the patched method runs the original until a call
// matches the trigger (1-based call count or predicate), that call signals
// `entered` and parks on a deferred until the test releases it. The test then
// KNOWS the call is in flight instead of inferring it from wall-clock delays.
//
//   const gate = barrier(fh, 'writev', 1);       // park the first writev
//   const op = wal.append(frame);                // drives the writev
//   await gate.entered;                          // provably in flight now
//   …assertions while the write is stuck…
//   gate.release();                              // let it land
//   await op;
//
// Works on any object method: FileHandle writev/sync, the fs/promises default
// export's rename/copyFile/truncate (all importers share that object), and
// prototype methods such as TextIndex.build (patch the prototype, every
// instance is gated). For tokenizer-style plain functions, wrap them with
// deferred() directly.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function tmpDir(prefix = 'minidb-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (err?: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (err?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Poll a condition on the macrotask queue until it holds (or the timeout
 *  makes the failure loud). Use this instead of a fixed sleep when waiting
 *  for an asynchronous state a barrier cannot signal directly. */
export async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

/** A live barrier over one object method (see the header). */
export interface MethodBarrier {
  /** Total calls the patched method has seen (1-based trigger counts use this). */
  readonly calls: number;
  /** Resolves with the call number once the gated call is ENTERED (parked). */
  readonly entered: Promise<number>;
  /** Let the gated call(s) proceed to the original method. Idempotent. */
  release(): void;
  /** Restore the original method. */
  restore(): void;
}

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

/** Patch `owner[name]` so the call(s) selected by `when` (a 1-based call
 *  number or a predicate over the call number) park on a deferred. Matching
 *  calls signal `entered` and resume in order once release()d; non-matching
 *  calls pass through synchronously. */
export function barrier<Owner extends object>(
  owner: Owner,
  name: keyof Owner & string,
  when: number | ((call: number) => boolean) = 1,
): MethodBarrier {
  const original = (owner as unknown as Record<string, AnyMethod>)[name]!;
  const matches = typeof when === 'number' ? (call: number) => call === when : when;
  const enteredD = deferred<number>();
  let released = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = () => {
      if (!released) {
        released = true;
        r();
      }
    };
  });
  let calls = 0;
  (owner as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
    calls++;
    const call = calls;
    if (matches(call)) {
      enteredD.resolve(call);
      return gate.then(() => original.apply(this, args));
    }
    return original.apply(this, args);
  };
  return {
    get calls() {
      return calls;
    },
    entered: enteredD.promise,
    release,
    restore() {
      (owner as Record<string, unknown>)[name] = original;
    },
  };
}

/** One-shot failure injection: the call(s) selected by `when` reject with
 *  `error`; every other call runs the original. */
export function failCalls<Owner extends object>(
  owner: Owner,
  name: keyof Owner & string,
  error: unknown,
  when: number | ((call: number) => boolean) = 1,
): { readonly calls: number; restore(): void } {
  const original = (owner as unknown as Record<string, AnyMethod>)[name]!;
  const matches = typeof when === 'number' ? (call: number) => call === when : when;
  let calls = 0;
  (owner as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
    calls++;
    if (matches(calls)) return Promise.reject(error);
    return original.apply(this, args);
  };
  return {
    get calls() {
      return calls;
    },
    restore() {
      (owner as Record<string, unknown>)[name] = original;
    },
  };
}
