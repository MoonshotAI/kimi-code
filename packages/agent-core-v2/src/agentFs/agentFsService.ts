/**
 * `agentFs` domain (L1) — `IAgentFileSystem` implementation.
 *
 * Resolves paths against the session workspace and delegates IO to the
 * injected `IFileSystemBackend`; reads the work directory through
 * `workspaceContext`. Bound at Session scope.
 */

import { isAbsolute, resolve } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { NotImplementedError } from '#/_base/errors';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IWorkspaceContext } from '#/workspaceContext';

import { type AgentFileStat, IAgentFileSystem, IFileSystemBackend } from './agentFs';

export class AgentFileSystem implements IAgentFileSystem {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFileSystemBackend private readonly backend: IFileSystemBackend,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
  ) {}

  get cwd(): string {
    return this.workspace.workDir;
  }

  private abs(path: string): string {
    return isAbsolute(path) ? path : resolve(this.cwd, path);
  }

  readText(path: string): Promise<string> {
    return this.backend.readText(this.abs(path));
  }

  writeText(path: string, data: string): Promise<void> {
    return this.backend.writeText(this.abs(path), data);
  }

  readBytes(path: string): Promise<Uint8Array> {
    return this.backend.readBytes(this.abs(path));
  }

  writeBytes(path: string, data: Uint8Array): Promise<void> {
    return this.backend.writeBytes(this.abs(path), data);
  }

  stat(path: string): Promise<AgentFileStat> {
    return this.backend.stat(this.abs(path));
  }

  readdir(path: string): Promise<readonly string[]> {
    return this.backend.readdir(this.abs(path));
  }

  glob(pattern: string): Promise<readonly string[]> {
    return this.backend.glob(this.cwd, pattern);
  }

  mkdir(path: string): Promise<void> {
    return this.backend.mkdir(this.abs(path));
  }

  withCwd(_cwd: string): IAgentFileSystem {
    throw new NotImplementedError('agentFs.withCwd');
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentFileSystem,
  AgentFileSystem,
  InstantiationType.Delayed,
  'agentFs',
);
