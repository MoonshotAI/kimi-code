import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

import { join } from 'pathe';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { parseBooleanEnv } from '#/_base/utils/env';
import { LifecycleScope } from '#/app/scopes';

import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  ISessionLockService,
  SessionLockHolds,
  sessionOccupiedError,
  type SessionLockHolder,
} from '#/persistence/interface/sessionLock';

const LOCK_FILE_VERSION = 1;

export const SESSION_LOCK_ENV = 'KIMI_CODE_SESSION_LOCK';

const UNREADABLE_HOLDER: SessionLockHolder = {
  version: 0,
  token: '',
  pid: 0,
  hostname: '',
  startedAt: 0,
  clientIdentity: 'unknown',
};

type ClaimOutcome =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly holder: SessionLockHolder | undefined };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (process.platform === 'win32') return true;
  try {
    const stat = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
      timeout: 1000,
    });
    return !stat.trim().startsWith('Z');
  } catch {
    return true;
  }
}

export class SessionLockService extends SessionLockHolds {
  private readonly lockDir: string;
  private readonly hostname: string;
  private readonly clientIdentity: string;
  private readonly disabled: boolean;
  private lockDirReady = false;
  private exitListener: (() => void) | undefined;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.lockDir = join(bootstrap.homeDir, 'locks', 'sessions');
    this.hostname = os.hostname();
    this.clientIdentity = bootstrap.clientIdentity.platform || bootstrap.clientIdentity.productName;
    this.disabled = parseBooleanEnv(bootstrap.getEnv(SESSION_LOCK_ENV)) === false;
  }

  protected publish(sessionId: string): string {
    const token = `${process.pid}:${randomUUID()}`;
    if (this.disabled) return token;
    let outcome: ClaimOutcome;
    try {
      outcome = this.claim(this.lockPath(sessionId), token);
    } catch (error) {
      this.log.warn('session lock unavailable; continuing without lock', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return token;
    }
    if (!outcome.claimed) throw sessionOccupiedError(sessionId, outcome.holder);
    this.watchExit();
    return token;
  }

  protected unpublish(sessionId: string, token: string): void {
    try {
      const lockPath = this.lockPath(sessionId);
      if (this.readHolder(lockPath)?.token === token) this.unlinkSilent(lockPath);
    } catch {
      return;
    } finally {
      if (!this.holding) this.unwatchExit();
    }
  }

  protected evict(sessionId: string): void {
    const lockPath = this.lockPath(sessionId);
    const holder = this.readHolder(lockPath);
    if (holder === undefined) return;
    this.log.warn('taking over session lock', { sessionId, holder });
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private claim(lockPath: string, token: string): ClaimOutcome {
    this.ensureLockDir();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.tryPublish(lockPath, this.payload(token))) return { claimed: true };
      const current = this.readHolder(lockPath);
      if (current !== undefined && this.alive(current)) return { claimed: false, holder: current };
      this.reclaim(lockPath, token);
    }
    return { claimed: false, holder: this.readHolder(lockPath) };
  }

  private watchExit(): void {
    if (this.exitListener !== undefined) return;
    this.exitListener = () => this.releaseAll();
    process.on('exit', this.exitListener);
  }

  private unwatchExit(): void {
    if (this.exitListener === undefined) return;
    process.off('exit', this.exitListener);
    this.exitListener = undefined;
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
    const tmp = `${lockPath}.tmp-${process.pid}-${randomUUID()}`;
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
    let parsed: Partial<SessionLockHolder>;
    try {
      parsed = JSON.parse(raw) as Partial<SessionLockHolder>;
    } catch {
      return UNREADABLE_HOLDER;
    }
    return {
      version: typeof parsed.version === 'number' ? parsed.version : UNREADABLE_HOLDER.version,
      token: typeof parsed.token === 'string' ? parsed.token : UNREADABLE_HOLDER.token,
      pid: typeof parsed.pid === 'number' ? parsed.pid : UNREADABLE_HOLDER.pid,
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : UNREADABLE_HOLDER.hostname,
      startedAt:
        typeof parsed.startedAt === 'number' ? parsed.startedAt : UNREADABLE_HOLDER.startedAt,
      clientIdentity:
        typeof parsed.clientIdentity === 'string'
          ? parsed.clientIdentity
          : UNREADABLE_HOLDER.clientIdentity,
    };
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
