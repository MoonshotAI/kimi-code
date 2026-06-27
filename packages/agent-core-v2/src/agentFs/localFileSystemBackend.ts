/**
 * `agentFs` domain (L1) — local `IFileSystemBackend` implementation.
 *
 * Backs the Agent filesystem with the real local disk by delegating to the
 * program-side `hostFs` primitives. Registered as the default
 * `IFileSystemBackend` at Session scope; remote backends override it via the
 * scope registry.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { NotImplementedError } from '#/_base/errors';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IHostFileSystem } from '#/hostFs';

import { type AgentFileStat, IFileSystemBackend } from './agentFs';

export class LocalFileSystemBackend implements IFileSystemBackend {
  declare readonly _serviceBrand: undefined;

  constructor(@IHostFileSystem private readonly hostFs: IHostFileSystem) {}

  readText(absPath: string): Promise<string> {
    return this.hostFs.readText(absPath);
  }

  writeText(absPath: string, data: string): Promise<void> {
    return this.hostFs.writeText(absPath, data);
  }

  readBytes(absPath: string): Promise<Uint8Array> {
    return this.hostFs.readBytes(absPath);
  }

  writeBytes(absPath: string, data: Uint8Array): Promise<void> {
    return this.hostFs.writeBytes(absPath, data);
  }

  async stat(absPath: string): Promise<AgentFileStat> {
    const s = await this.hostFs.stat(absPath);
    return { isFile: s.isFile, isDirectory: s.isDirectory, size: s.size };
  }

  async readdir(absPath: string): Promise<readonly string[]> {
    const entries = await this.hostFs.readdir(absPath);
    return entries.map((e) => e.name);
  }

  glob(_absDir: string, _pattern: string): Promise<readonly string[]> {
    throw new NotImplementedError('localFileSystemBackend.glob');
  }

  mkdir(absPath: string): Promise<void> {
    return this.hostFs.mkdir(absPath, { recursive: true });
  }
}

registerScopedService(
  LifecycleScope.Session,
  IFileSystemBackend,
  LocalFileSystemBackend,
  InstantiationType.Delayed,
  'agentFs',
);
