/**
 * `agentFs` domain (L1) — the Agent's filesystem.
 *
 * Defines the `ISessionAgentFileSystem` that business code injects to read and
 * write files inside the Agent's execution environment. Session-scoped; the
 * implementation resolves relative paths against `IExecContext.cwd` and talks
 * to Node's `fs/promises` directly.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { TextDecodeErrors } from '#/_base/execEnv';

export interface AgentFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
  /** Last-modified time in epoch milliseconds, when the backend exposes it. */
  readonly mtimeMs?: number;
  /** Inode number, when the backend exposes it (`0` on backends without inodes). */
  readonly ino?: number;
}

export interface ISessionAgentFileSystem {
  readonly _serviceBrand: undefined;

  readonly cwd: string;

  readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string>;
  writeText(
    path: string,
    data: string,
    options?: { mode?: 'w' | 'a'; encoding?: BufferEncoding },
  ): Promise<void>;
  readBytes(path: string, n?: number): Promise<Uint8Array>;
  readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<AgentFileStat>;
  readdir(path: string): Promise<readonly string[]>;
  glob(pattern: string): Promise<readonly string[]>;
  mkdir(
    path: string,
    options?: { readonly parents?: boolean; readonly existOk?: boolean },
  ): Promise<void>;
  withCwd(cwd: string): ISessionAgentFileSystem;
}

export const ISessionAgentFileSystem: ServiceIdentifier<ISessionAgentFileSystem> =
  createDecorator<ISessionAgentFileSystem>('sessionAgentFileSystem');
