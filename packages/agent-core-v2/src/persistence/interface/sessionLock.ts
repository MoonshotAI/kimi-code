import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Error2, isError2 } from '#/_base/errors/errors';
import { Emitter, type Event } from '#/_base/event';

import { SessionErrors } from '#/session/errors';

export interface SessionLockHolder {
  readonly version: number;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: number;
  readonly clientIdentity: string;
}

export interface SessionLockLease {
  readonly sessionId: string;
  release(): void;
}

export interface SessionLockHeldEvent {
  readonly sessionId: string;
}

export interface ISessionLockService {
  readonly _serviceBrand: undefined;

  readonly onDidHold: Event<SessionLockHeldEvent>;

  hold(sessionId: string): void;
  tryHold(sessionId: string): boolean;
  release(sessionId: string): void;
  lease(sessionId: string): SessionLockLease;
  held(sessionId: string): boolean;
}

export const ISessionLockService: ServiceIdentifier<ISessionLockService> =
  createDecorator<ISessionLockService>('sessionLockService');

export function sessionOccupiedError(sessionId: string, holder?: SessionLockHolder): Error2 {
  return new Error2(
    SessionErrors.codes.SESSION_OCCUPIED,
    'This session is in use by another Kimi Code process. Stop the session in that process or exit it, then try again.',
    { details: { sessionId, holder } },
  );
}

interface HeldState {
  readonly token: string;
  held: boolean;
  leases: number;
}

export abstract class SessionLockHolds extends Disposable implements ISessionLockService {
  declare readonly _serviceBrand: undefined;

  private readonly heldSessions = new Map<string, HeldState>();
  private readonly holdEmitter = this._register(new Emitter<SessionLockHeldEvent>());
  readonly onDidHold: Event<SessionLockHeldEvent> = this.holdEmitter.event;

  protected abstract publish(sessionId: string): string;
  protected abstract unpublish(sessionId: string, token: string): void;

  hold(sessionId: string): void {
    this.stateFor(sessionId).held = true;
  }

  tryHold(sessionId: string): boolean {
    try {
      this.hold(sessionId);
      return true;
    } catch (error) {
      if (isError2(error) && error.code === SessionErrors.codes.SESSION_OCCUPIED) return false;
      throw error;
    }
  }

  release(sessionId: string): void {
    const state = this.heldSessions.get(sessionId);
    if (state === undefined || !state.held) return;
    state.held = false;
    this.unpublishIfUnused(sessionId, state);
  }

  lease(sessionId: string): SessionLockLease {
    const state = this.stateFor(sessionId);
    state.leases += 1;
    let released = false;
    return {
      sessionId,
      release: () => {
        if (released) return;
        released = true;
        state.leases -= 1;
        this.unpublishIfUnused(sessionId, state);
      },
    };
  }

  held(sessionId: string): boolean {
    return this.heldSessions.has(sessionId);
  }

  override dispose(): void {
    this.releaseAll();
    super.dispose();
  }

  protected get holding(): boolean {
    return this.heldSessions.size > 0;
  }

  protected releaseAll(): void {
    const held = [...this.heldSessions];
    this.heldSessions.clear();
    for (const [sessionId, state] of held) this.unpublish(sessionId, state.token);
  }

  private stateFor(sessionId: string): HeldState {
    let state = this.heldSessions.get(sessionId);
    if (state === undefined) {
      state = { token: this.publish(sessionId), held: false, leases: 0 };
      this.heldSessions.set(sessionId, state);
      this.holdEmitter.fire({ sessionId });
    }
    return state;
  }

  private unpublishIfUnused(sessionId: string, state: HeldState): void {
    if (state.held || state.leases > 0) return;
    if (this.heldSessions.get(sessionId) !== state) return;
    this.heldSessions.delete(sessionId);
    this.unpublish(sessionId, state.token);
  }
}
