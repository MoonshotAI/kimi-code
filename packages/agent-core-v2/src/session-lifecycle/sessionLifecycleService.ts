/**
 * `session-lifecycle` domain (L6) — `ISessionLifecycleService` implementation.
 *
 * Owns the process-wide registry of open Session child scopes, creating them
 * through the DI scope tree and seeding each with its identity and storage
 * addressing. Materializes the session's initial metadata on creation by
 * resolving `session-metadata`. Bound at Core scope. Persisted sessions are
 * the `session-index` read model.
 */

import { join, relative } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import {
  createScopedChildHandle,
  type IScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/bootstrap';
import { NotImplementedError } from '#/errors';
import { IKaos, IKaosFactory } from '#/kaos';
import { ISessionService } from '#/session';
import { type ISessionContext, sessionContextSeed } from '#/session-context';
import { ISessionMetadata } from '#/session-metadata';
import { ISkillCatalog } from '#/skill';

import {
  type CreateSessionOptions,
  type ForkSessionOptions,
  ISessionLifecycleService,
} from './sessionLifecycle';

export class SessionLifecycleService implements ISessionLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, IScopeHandle>();

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IKaosFactory private readonly kaosFactory: IKaosFactory,
  ) {}

  async create(opts: CreateSessionOptions): Promise<IScopeHandle> {
    const workspaceId = encodeWorkDirKey(opts.workDir);
    const sessionDir = join(this.bootstrap.sessionsDir, workspaceId, opts.sessionId);
    const metaScope = join(relative(this.bootstrap.homeDir, sessionDir), 'session-meta');
    const ctx: ISessionContext = {
      _serviceBrand: undefined,
      sessionId: opts.sessionId,
      workspaceId,
      sessionDir,
      metaScope,
    };
    const kaos = await this.kaosFactory.createLocal(opts.workDir);
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Session,
      opts.sessionId,
      {
        extra: [
          ...sessionContextSeed(ctx),
          [IKaos, kaos] as const,
        ],
      },
    );
    this.sessions.set(opts.sessionId, handle);
    await handle.accessor.get(ISessionMetadata).ready;
    void handle.accessor.get(ISkillCatalog).load();
    return handle;
  }

  get(sessionId: string): IScopeHandle | undefined {
    return this.sessions.get(sessionId);
  }

  list(): readonly IScopeHandle[] {
    return [...this.sessions.values()];
  }

  async close(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    this.sessions.delete(sessionId);
    handle.dispose();
  }

  async archive(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    await handle.accessor.get(ISessionService).archive();
    this.sessions.delete(sessionId);
    handle.dispose();
  }

  fork(_opts: ForkSessionOptions): Promise<IScopeHandle> {
    throw new NotImplementedError('SessionLifecycleService.fork');
  }
}

registerScopedService(
  LifecycleScope.Core,
  ISessionLifecycleService,
  SessionLifecycleService,
  InstantiationType.Delayed,
  'session-lifecycle',
);
