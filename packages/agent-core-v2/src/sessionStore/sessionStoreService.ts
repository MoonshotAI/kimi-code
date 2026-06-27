/**
 * `sessionStore` domain (L2) — `ISessionStore` implementation.
 *
 * Enumerates session directories on the real local disk through the program
 * side `hostFs` primitives. Bound at Core scope.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { slugifyWorkDirName } from '#/_base/utils/workdir-slug';
import { IHostFileSystem } from '#/hostFs';

import { ISessionStore } from './sessionStore';

const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

export function encodeWorkDirKey(workDir: string): string {
  const normalized = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalized.split('/').pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

export class SessionStore implements ISessionStore {
  declare readonly _serviceBrand: undefined;

  constructor(@IHostFileSystem private readonly hostFs: IHostFileSystem) {}

  sessionDir(sessionsRoot: string, workDir: string, sessionId: string): string {
    return `${sessionsRoot}/${encodeWorkDirKey(workDir)}/${sessionId}`;
  }

  workspaceIdFor(workDir: string): string {
    return encodeWorkDirKey(workDir);
  }

  async countActiveSessions(sessionsRoot: string, workDir: string): Promise<number> {
    const dir = join(sessionsRoot, encodeWorkDirKey(workDir));
    let entries;
    try {
      entries = await this.hostFs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (await this.isSessionArchived(join(dir, entry.name))) continue;
      count += 1;
    }
    return count;
  }

  private async isSessionArchived(sessionDir: string): Promise<boolean> {
    try {
      const raw = await this.hostFs.readText(join(sessionDir, 'state.json'));
      const parsed = JSON.parse(raw) as unknown;
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { archived?: boolean }).archived === true
      );
    } catch {
      return false;
    }
  }
}

registerScopedService(
  LifecycleScope.Core,
  ISessionStore,
  SessionStore,
  InstantiationType.Delayed,
  'records',
);
