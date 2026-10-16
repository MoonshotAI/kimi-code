import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

import { join } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { isError2 } from '#/_base/errors/errors';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';

import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  ISessionLockService,
  sessionOccupiedError,
  type SessionLockHeldEvent,
  type SessionLockHolder,
  type SessionLockLease,
} from '#/persistence/interface/sessionLock';

const LOCK_FILE_VERSION = 1;

interface HeldState {
  token: string;
  run: boolean;
  explicit: number;
}

const heldServices = new Set<SessionLockService>();
let exitHooked = false;

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const service of heldServices) service.releaseAll();
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let tmpSeq = 0;

export class SessionLockService extends Disposable implements ISessionLockService {
  declare readonly _serviceBrand: undefined;

  private readonly heldLocks = new Map<string, HeldState>();
  private readonly lockDir: string;
  private readonly hostname: string;
  private readonly clientIdentity: string;
  private lockDirReady = false;
  private readonly holdEmitter = this._register(new Emitter<SessionLockHeldEvent>());
  readonly onDidHold: Event<SessionLockHeldEvent> = this.holdEmitter.event;

  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    super();
    this.lockDir = join(bootstrap.homeDir, 'locks', 'sessions');
    this.hostname = os.hostname();
    this.clientIdentity = bootstrap.clientIdentity.platform || bootstrap.clientIdentity.productName;
  }

  beginRun(sessionId: string): void {
    const state = this.heldLocks.get(sessionId);
    if (state !== undefined) {
      state.run = true;
      return;
    }
    this.heldLocks.set(sessionId, { token: this.publish(sessionId), run: true, explicit: 0 });
    this.holdEmitter.fire({ sessionId });
  }

  endRun(sessionId: string): void {
    const state = this.heldLocks.get(sessionId);
    if (state === undefined || !state.run) return;
    state.run = false;
    this.maybeUnlink(sessionId, state);
  }

  acquire(sessionId: string): SessionLockLease {
    let state = this.heldLocks.get(sessionId);
    if (state === undefined) {
      state = { token: this.publish(sessionId), run: false, explicit: 0 };
      this.heldLocks.set(sessionId, state);
      this.holdEmitter.fire({ sessionId });
    }
    state.explicit += 1;
    let released = false;
    return {
      sessionId,
      release: () => {
        if (released) return;
        released = true;
        state.explicit -= 1;
        this.maybeUnlink(sessionId, state);
      },
    };
  }

  held(sessionId: string): boolean {
    return this.heldLocks.has(sessionId);
  }

  holdToken(sessionId: string): string | undefined {
    return this.heldLocks.get(sessionId)?.token;
  }

  override dispose(): void {
    this.releaseAll();
    super.dispose();
  }

  releaseAll(): void {
    for (const [sessionId, state] of this.heldLocks) {
      this.unlinkIfMine(sessionId, state.token);
    }
    this.heldLocks.clear();
    heldServices.delete(this);
  }

  private maybeUnlink(sessionId: string, state: HeldState): void {
    if (state.run || state.explicit > 0) return;
    if (this.heldLocks.get(sessionId) !== state) return;
    this.heldLocks.delete(sessionId);
    if (this.heldLocks.size === 0) heldServices.delete(this);
    this.unlinkIfMine(sessionId, state.token);
  }

  private publish(sessionId: string): string {
    const token = `${process.pid}:${randomUUID()}`;
    try {
      this.ensureLockDir();
      const lockPath = this.lockPath(sessionId);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.tryPublish(lockPath, this.payload(token))) {
          heldServices.add(this);
          hookExit();
          return token;
        }
        const current = this.readHolder(lockPath);
        if (current !== undefined && this.alive(current)) {
          throw sessionOccupiedError(sessionId, current);
        }
        this.reclaim(lockPath, token);
      }
      throw sessionOccupiedError(sessionId, this.readHolder(lockPath));
    } catch (error) {
      if (isError2(error)) throw error;
      console.warn(
        `[session-lock] locking unavailable for session "${sessionId}", continuing without lock`,
        error,
      );
      return token;
    }
  }

  private reclaim(lockPath: string, token: string): void {
    const reclaimPath = `${lockPath}.reclaim`;
    if (!this.tryPublish(reclaimPath, this.payload(token))) {
      const current = this.readHolder(reclaimPath);
      if (current === undefined || !this.alive(current)) this.unlinkSilent(reclaimPath);
      return;
    }
    try {
      const current = this.readHolder(lockPath);
      if (current === undefined || !this.alive(current)) this.unlinkSilent(lockPath);
    } finally {
      this.unlinkSilent(reclaimPath);
    }
  }

  private tryPublish(lockPath: string, body: string): boolean {
    const tmp = `${lockPath}.tmp-${process.pid}-${++tmpSeq}`;
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.linkSync(tmp, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      this.unlinkSilent(tmp);
    }
  }

  private readHolder(lockPath: string): SessionLockHolder | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SessionLockHolder>;
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 0,
        token: typeof parsed.token === 'string' ? parsed.token : '',
        pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
        hostname: typeof parsed.hostname === 'string' ? parsed.hostname : '',
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
        clientIdentity:
          typeof parsed.clientIdentity === 'string' ? parsed.clientIdentity : 'unknown',
      };
    } catch {
      return { version: 0, token: '', pid: 0, hostname: '', startedAt: 0, clientIdentity: 'unknown' };
    }
  }

  private alive(holder: SessionLockHolder): boolean {
    if (holder.hostname !== '' && holder.hostname !== this.hostname) return true;
    if (!pidAlive(holder.pid)) return false;
    const bootTime = Date.now() - os.uptime() * 1000;
    return holder.startedAt >= bootTime;
  }

  private payload(token: string): string {
    return JSON.stringify({
      version: LOCK_FILE_VERSION,
      token,
      pid: process.pid,
      hostname: this.hostname,
      startedAt: Date.now(),
      clientIdentity: this.clientIdentity,
    } satisfies SessionLockHolder);
  }

  private unlinkIfMine(sessionId: string, token: string): void {
    try {
      const current = this.readHolder(this.lockPath(sessionId));
      if (current?.token === token) this.unlinkSilent(this.lockPath(sessionId));
    } catch {
      return;
    }
  }

  private unlinkSilent(path: string): void {
    try {
      fs.unlinkSync(path);
    } catch {
      return;
    }
  }

  private ensureLockDir(): void {
    if (this.lockDirReady) return;
    fs.mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
    this.lockDirReady = true;
  }

  private lockPath(sessionId: string): string {
    return join(this.lockDir, `${sessionId}.lock`);
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionLockService,
  SessionLockService,
  ScopeActivation.OnScopeCreated,
  'storage',
);
