import { join } from 'pathe';

import { createSessionSpace } from '@moonshot-ai/core/session/index';
import type {
  SessionInit,
  SessionPatch,
  SessionSpaceBackend,
  SessionUpdateOptions,
} from '@moonshot-ai/core/session/index';

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { encodeSessionMeta } from '#/session/sessionMetadata/sessionMetadataService';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';

import { ISessionSpace, type HostSessionSpace } from './sessionSpace';

function isMissingFileError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (unwrapped === null || typeof unwrapped !== 'object') return false;
  return (unwrapped as { readonly code?: unknown }).code === 'ENOENT';
}

class HostSessionSpaceBackend implements SessionSpaceBackend<SessionMeta> {
  constructor(
    private readonly root: string,
    private readonly rootDir: string,
    private readonly docs: IAtomicDocumentStore,
    private readonly hostFs: IHostFileSystem,
  ) {}

  async list(prefix?: string): Promise<readonly string[]> {
    const keys: string[] = [];
    await this.walk(this.rootDir, '', keys);
    return keys.filter((key) => prefix === undefined || key.startsWith(prefix));
  }

  async read(key: string): Promise<SessionMeta | undefined> {
    const scope = `${this.root}/${key}`;
    return (await this.docs.get<SessionMeta>(scope, 'state.json')) ??
      (await this.docs.get<SessionMeta>(`${scope}/session-meta`, 'state.json'));
  }

  async write(key: string, record: SessionMeta): Promise<void> {
    await this.docs.set(`${this.root}/${key}`, 'state.json', encodeSessionMeta(record));
  }

  async delete(key: string): Promise<boolean> {
    const dir = join(this.rootDir, key);
    try {
      await this.hostFs.stat(dir);
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
    await this.hostFs.remove(dir);
    return true;
  }

  private async walk(dir: string, key: string, keys: string[]): Promise<void> {
    let entries;
    try {
      entries = await this.hostFs.readdir(dir);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    if (key !== '' && entries.some((entry) => entry.isFile && entry.name === 'state.json')) {
      keys.push(key);
      return;
    }
    const legacy = entries.find((entry) => entry.isDirectory && entry.name === 'session-meta');
    if (key !== '' && legacy !== undefined) {
      const children = await this.hostFs.readdir(join(dir, legacy.name));
      if (children.some((entry) => entry.isFile && entry.name === 'state.json')) {
        keys.push(key);
        return;
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory || entry.isSymbolicLink === true || entry.name === 'session-meta') continue;
      await this.walk(join(dir, entry.name), key === '' ? entry.name : `${key}/${entry.name}`, keys);
    }
  }
}

export function createHostSessionSpace(
  bootstrap: IBootstrapService,
  docs: IAtomicDocumentStore,
  hostFs: IHostFileSystem,
): HostSessionSpace {
  const root = bootstrap.scope('sessions');
  const backend = new HostSessionSpaceBackend(root, join(bootstrap.homeDir, root), docs, hostFs);
  const space = createSessionSpace<SessionMeta>(backend);
  return {
    list: (prefix) => space.list(prefix),
    get: (key) => space.get(key),
    create: (key, init) => space.create(key, init),
    update: (key, patch, opts) => space.update(key, patch, opts),
    delete: (key) => space.delete(key),
    keyFor: (scope) => scope.startsWith(`${root}/`) ? scope.slice(root.length + 1) : scope,
    set: (key, record) => backend.write(key, record),
  };
}

export class SessionSpaceService implements ISessionSpace {
  declare readonly _serviceBrand: undefined;

  private readonly space: HostSessionSpace;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IAtomicDocumentStore docs: IAtomicDocumentStore,
    @IHostFileSystem hostFs: IHostFileSystem,
  ) {
    this.space = createHostSessionSpace(bootstrap, docs, hostFs);
  }

  keyFor(scope: string): string {
    return this.space.keyFor(scope);
  }

  list(prefix?: string): Promise<readonly string[]> {
    return this.space.list(prefix);
  }

  get(key: string): Promise<SessionMeta | undefined> {
    return this.space.get(key);
  }

  create(key: string, init: SessionInit<SessionMeta>): Promise<SessionMeta> {
    return this.space.create(key, init);
  }

  update(
    key: string,
    patch: SessionPatch<SessionMeta>,
    opts?: SessionUpdateOptions,
  ): Promise<SessionMeta> {
    return this.space.update(key, patch, opts);
  }

  set(key: string, record: SessionMeta): Promise<void> {
    return this.space.set(key, record);
  }

  delete(key: string): Promise<void> {
    return this.space.delete(key);
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionSpace,
  SessionSpaceService,
  ScopeActivation.OnScopeCreated,
  'storage',
);
