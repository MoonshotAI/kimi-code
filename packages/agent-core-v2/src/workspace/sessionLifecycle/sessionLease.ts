import { randomUUID } from 'node:crypto';

import { join } from 'pathe';

import { Disposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IntervalTimer } from '#/_base/utils/timer';
import { Error2, ErrorCodes } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

export const SESSION_LEASE_FILE = 'lease.json';

export interface SessionLeaseTiming {
  readonly renewIntervalMs: number;
  readonly staleAfterMs: number;
}

export const DEFAULT_SESSION_LEASE_TIMING: SessionLeaseTiming = {
  renewIntervalMs: 5_000,
  staleAfterMs: 30_000,
};

export interface SessionLeaseHolder {
  readonly leaseId: string;
  readonly pid: number;
  readonly serverId: string;
  readonly acquiredAt: number;
  readonly renewedAt: number;
}

interface HeldLease {
  readonly sessionId: string;
  readonly filePath: string;
  holder: SessionLeaseHolder;
  readonly timer: IntervalTimer;
  readonly onLost: () => void;
  chain: Promise<void>;
  active: boolean;
}

export class SessionLeaseManager extends Disposable {
  private readonly held = new Map<string, HeldLease>();
  private readonly timing: SessionLeaseTiming;
  private readonly serverId = randomUUID();
  private disposed = false;

  constructor(
    private readonly fs: IHostFileSystem,
    private readonly log: ILogService,
    private readonly sessionDirFor: (sessionId: string) => string,
    timing?: Partial<SessionLeaseTiming>,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.timing = { ...DEFAULT_SESSION_LEASE_TIMING, ...timing };
  }

  isHeld(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  async acquire(sessionId: string, onLost: () => void): Promise<SessionLeaseHolder> {
    const existing = this.held.get(sessionId);
    if (existing !== undefined) return existing.holder;
    const dir = this.sessionDirFor(sessionId);
    const filePath = join(dir, SESSION_LEASE_FILE);
    await this.fs.mkdir(dir, { recursive: true });
    const holder: SessionLeaseHolder = {
      leaseId: randomUUID(),
      pid: process.pid,
      serverId: this.serverId,
      acquiredAt: this.now(),
      renewedAt: this.now(),
    };
    const encoded = encodeLease(holder);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await this.fs.createExclusive(filePath, encoded)) {
        this.track(sessionId, filePath, holder, onLost);
        return holder;
      }
      const holderOnDisk = await this.readHolder(filePath);
      const mtimeMs = await this.mtimeOf(filePath);
      if (mtimeMs === undefined) continue;
      if (this.now() - mtimeMs <= this.timing.staleAfterMs) {
        throw this.lockedError(sessionId, holderOnDisk);
      }
      this.log.warn('session lease heartbeat expired, attempting takeover', {
        sessionId,
        holder: holderOnDisk,
      });
      await this.fs.remove(filePath);
      if (await this.fs.createExclusive(filePath, encoded)) {
        this.track(sessionId, filePath, holder, onLost);
        return holder;
      }
      throw this.lockedError(sessionId, await this.readHolder(filePath));
    }
    throw this.lockedError(sessionId, await this.readHolder(filePath));
  }

  async release(sessionId: string): Promise<void> {
    const entry = this.held.get(sessionId);
    if (entry === undefined) return;
    entry.active = false;
    entry.timer.cancel();
    this.held.delete(sessionId);
    await entry.chain.catch(() => undefined);
    const current = await this.readHolder(entry.filePath);
    if (current?.leaseId !== entry.holder.leaseId) return;
    await this.fs.remove(entry.filePath).catch((error: unknown) => {
      this.log.warn('session lease release failed', { sessionId, error });
    });
  }

  async releaseAll(): Promise<void> {
    for (const sessionId of this.held.keys()) {
      await this.release(sessionId).catch((error: unknown) => {
        this.log.warn('session lease release failed', { sessionId, error });
      });
    }
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.held.values()) {
      entry.active = false;
      entry.timer.cancel();
    }
    void this.releaseAll().catch((error: unknown) => {
      this.log.error('session lease teardown failed', error);
    });
    super.dispose();
  }

  private track(
    sessionId: string,
    filePath: string,
    holder: SessionLeaseHolder,
    onLost: () => void,
  ): void {
    const entry: HeldLease = {
      sessionId,
      filePath,
      holder,
      timer: new IntervalTimer({ unref: true }),
      onLost,
      chain: Promise.resolve(),
      active: true,
    };
    this.held.set(sessionId, entry);
    entry.timer.cancelAndSet(() => {
      if (!entry.active || this.disposed) return;
      entry.chain = entry.chain.then(
        () => this.renew(entry),
        () => this.renew(entry),
      );
    }, this.timing.renewIntervalMs);
  }

  private async renew(entry: HeldLease): Promise<void> {
    if (!entry.active) return;
    let isFile: boolean;
    let mtimeMs: number | undefined;
    try {
      const stat = await this.fs.stat(entry.filePath);
      isFile = stat.isFile;
      mtimeMs = stat.mtimeMs;
    } catch {
      this.lost(entry);
      return;
    }
    if (!isFile) {
      this.lost(entry);
      return;
    }
    const holderOnDisk = await this.readHolder(entry.filePath);
    if (holderOnDisk === undefined) {
      if (mtimeMs !== undefined && this.now() - mtimeMs <= this.timing.staleAfterMs) return;
      this.lost(entry);
      return;
    }
    if (holderOnDisk.leaseId !== entry.holder.leaseId) {
      this.lost(entry);
      return;
    }
    const renewed: SessionLeaseHolder = { ...entry.holder, renewedAt: this.now() };
    try {
      await this.fs.writeText(entry.filePath, JSON.stringify(renewed));
      entry.holder = renewed;
    } catch (error) {
      this.log.warn('session lease renew failed', {
        sessionId: entry.sessionId,
        error,
      });
      this.lost(entry);
    }
  }

  private lost(entry: HeldLease): void {
    if (!entry.active) return;
    entry.active = false;
    entry.timer.cancel();
    this.held.delete(entry.sessionId);
    this.log.warn('session lease lost', {
      sessionId: entry.sessionId,
      filePath: entry.filePath,
    });
    try {
      entry.onLost();
    } catch (error) {
      this.log.error('session lease lost handler failed', error);
    }
  }

  private async readHolder(filePath: string): Promise<SessionLeaseHolder | undefined> {
    let raw: string;
    try {
      raw = await this.fs.readText(filePath);
    } catch {
      return undefined;
    }
    return parseLease(raw);
  }

  private async mtimeOf(filePath: string): Promise<number | undefined> {
    try {
      const stat = await this.fs.stat(filePath);
      return stat.isFile ? stat.mtimeMs : undefined;
    } catch {
      return undefined;
    }
  }

  private lockedError(sessionId: string, holder: SessionLeaseHolder | undefined): Error2 {
    const message =
      holder === undefined
        ? `Session "${sessionId}" is locked by another kimi-code instance`
        : `Session "${sessionId}" is locked by another kimi-code instance (pid ${holder.pid}, server ${holder.serverId}, acquired ${new Date(holder.acquiredAt).toISOString()})`;
    return new Error2(ErrorCodes.SESSION_LOCKED, message, {
      details: { sessionId, holder },
    });
  }
}

function encodeLease(holder: SessionLeaseHolder): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(holder));
}

function parseLease(raw: string): SessionLeaseHolder | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['leaseId'] !== 'string') return undefined;
  if (typeof candidate['pid'] !== 'number') return undefined;
  if (typeof candidate['serverId'] !== 'string') return undefined;
  if (typeof candidate['acquiredAt'] !== 'number') return undefined;
  if (typeof candidate['renewedAt'] !== 'number') return undefined;
  return candidate as unknown as SessionLeaseHolder;
}
