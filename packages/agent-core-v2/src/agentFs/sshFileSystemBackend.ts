/**
 * `agentFs` domain (L1) — ssh `IFileSystemBackend` stub.
 *
 * Placeholder for the remote backend; not registered into the scope registry
 * yet. A composition root that needs ssh supplies it through
 * `ScopeOptions.extra` to override the local backend.
 */

import { NotImplementedError } from '#/_base/errors';

import { type AgentFileStat, IFileSystemBackend } from './agentFs';

export class SshFileSystemBackend implements IFileSystemBackend {
  declare readonly _serviceBrand: undefined;

  readText(_absPath: string): Promise<string> {
    throw new NotImplementedError('sshFileSystemBackend');
  }

  writeText(_absPath: string, _data: string): Promise<void> {
    throw new NotImplementedError('sshFileSystemBackend');
  }

  readBytes(_absPath: string): Promise<Uint8Array> {
    throw new NotImplementedError('sshFileSystemBackend');
  }

  writeBytes(_absPath: string, _data: Uint8Array): Promise<void> {
    throw new NotImplementedError('sshFileSystemBackend');
  }

  stat(_absPath: string): Promise<AgentFileStat> {
    throw new NotImplementedError('sshFileSystemBackend');
  }

  readdir(_absPath: string): Promise<readonly string[]> {
    throw new NotImplementedError('sshFileSystemBackend');
  }

  glob(_absDir: string, _pattern: string): Promise<readonly string[]> {
    throw new NotImplementedError('sshFileSystemBackend');
  }

  mkdir(_absPath: string): Promise<void> {
    throw new NotImplementedError('sshFileSystemBackend');
  }
}
