import { AsyncLocalStorage } from 'node:async_hooks';

import { KaosError } from './errors';
import type { Kaos } from './kaos';
import type { KaosProcess } from './process';
import type { StatResult } from './types';

const kaosStorage = new AsyncLocalStorage<Kaos>();

/**
 * Return the {@link Kaos} instance bound to the current async context.
 *
 * Throws if nothing is bound — callers must wrap their entry point in
 * {@link runWithKaos} or call {@link setCurrentKaos} once at startup.
 */
export function getCurrentKaos(): Kaos {
  const store = kaosStorage.getStore();
  if (store === undefined) {
    throw new KaosError(
      'No Kaos is bound to the current async context. Call `setCurrentKaos(await LocalKaos.create())` once at startup, or wrap the call in `runWithKaos(...)`.',
    );
  }
  return store;
}

/**
 * Bind `kaos` as the current instance for the running async context tree.
 * Intended for a one-shot call at process startup (e.g. in a test setup
 * file). Subsequent code in the same context — including nested awaits —
 * resolves {@link getCurrentKaos} to this instance unless overridden by
 * {@link runWithKaos}.
 */
export function setCurrentKaos(kaos: Kaos): void {
  kaosStorage.enterWith(kaos);
}

/**
 * Run `fn` with `kaos` bound as the current Kaos instance for its async
 * subtree. Concurrent calls do not pollute each other — bindings are
 * scoped to the {@link AsyncLocalStorage} context.
 */
export function runWithKaos<T>(kaos: Kaos, fn: () => T): T {
  return kaosStorage.run(kaos, fn);
}

// Module-level convenience functions for the current Kaos instance.

export function readText(
  path: string,
  options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
): Promise<string> {
  return getCurrentKaos().readText(path, options);
}

export function writeText(
  path: string,
  data: string,
  options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
): Promise<number> {
  return getCurrentKaos().writeText(path, data, options);
}

export function readLines(
  path: string,
  options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
): AsyncGenerator<string> {
  return getCurrentKaos().readLines(path, options);
}

export function exec(...args: string[]): Promise<KaosProcess> {
  return getCurrentKaos().exec(...args);
}

export function readBytes(path: string, n?: number): Promise<Buffer> {
  return getCurrentKaos().readBytes(path, n);
}

export function writeBytes(path: string, data: Buffer): Promise<number> {
  return getCurrentKaos().writeBytes(path, data);
}

export function stat(path: string, options?: { followSymlinks?: boolean }): Promise<StatResult> {
  return getCurrentKaos().stat(path, options);
}

export function mkdir(
  path: string,
  options?: { parents?: boolean; existOk?: boolean },
): Promise<void> {
  return getCurrentKaos().mkdir(path, options);
}

export function iterdir(path: string): AsyncGenerator<string> {
  return getCurrentKaos().iterdir(path);
}

export function glob(
  path: string,
  pattern: string,
  options?: { caseSensitive?: boolean },
): AsyncGenerator<string> {
  return getCurrentKaos().glob(path, pattern, options);
}

export function chdir(path: string): Promise<void> {
  return getCurrentKaos().chdir(path);
}

export function getcwd(): string {
  return getCurrentKaos().getcwd();
}

export function gethome(): string {
  return getCurrentKaos().gethome();
}

export function normpath(path: string): string {
  return getCurrentKaos().normpath(path);
}

export function pathClass(): 'posix' | 'win32' {
  return getCurrentKaos().pathClass();
}

export function execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess> {
  return getCurrentKaos().execWithEnv(args, env);
}
