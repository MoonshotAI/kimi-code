/**
 * `agentFs` domain (L1) — the Agent's filesystem and its pluggable backend.
 *
 * Defines the `IAgentFileSystem` that business code injects to read and write
 * files inside the Agent's execution environment, plus the internal
 * `IFileSystemBackend` provider that hides the local/ssh/container split.
 * Session-scoped. Business code depends on `IAgentFileSystem` only; the
 * backend is wired through the scope registry.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface AgentFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
}

export interface IAgentFileSystem {
  readonly _serviceBrand: undefined;

  readonly cwd: string;

  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<AgentFileStat>;
  readdir(path: string): Promise<readonly string[]>;
  glob(pattern: string): Promise<readonly string[]>;
  mkdir(path: string): Promise<void>;
  withCwd(cwd: string): IAgentFileSystem;
}

export const IAgentFileSystem: ServiceIdentifier<IAgentFileSystem> =
  createDecorator<IAgentFileSystem>('agentFileSystem');

export interface IFileSystemBackend {
  readonly _serviceBrand: undefined;

  readText(absPath: string): Promise<string>;
  writeText(absPath: string, data: string): Promise<void>;
  readBytes(absPath: string): Promise<Uint8Array>;
  writeBytes(absPath: string, data: Uint8Array): Promise<void>;
  stat(absPath: string): Promise<AgentFileStat>;
  readdir(absPath: string): Promise<readonly string[]>;
  glob(absDir: string, pattern: string): Promise<readonly string[]>;
  mkdir(absPath: string): Promise<void>;
}

export const IFileSystemBackend: ServiceIdentifier<IFileSystemBackend> =
  createDecorator<IFileSystemBackend>('fileSystemBackend');
