import { Emitter, type Event } from '#/_base/event';

import {
  ISessionLockService,
  type SessionLockHeldEvent,
  type SessionLockLease,
} from '#/persistence/interface/sessionLock';

interface HeldState {
  run: boolean;
  explicit: number;
}

export class InMemorySessionLockService implements ISessionLockService {
  declare readonly _serviceBrand: undefined;

  private readonly heldSessions = new Map<string, HeldState>();
  private readonly holdEmitter = new Emitter<SessionLockHeldEvent>();
  readonly onDidHold: Event<SessionLockHeldEvent> = this.holdEmitter.event;

  beginRun(sessionId: string): void {
    const state = this.heldSessions.get(sessionId);
    if (state !== undefined) {
      state.run = true;
      return;
    }
    this.heldSessions.set(sessionId, { run: true, explicit: 0 });
    this.holdEmitter.fire({ sessionId });
  }

  endRun(sessionId: string): void {
    const state = this.heldSessions.get(sessionId);
    if (state === undefined || !state.run) return;
    state.run = false;
    if (state.explicit === 0) this.heldSessions.delete(sessionId);
  }

  acquire(sessionId: string): SessionLockLease {
    let state = this.heldSessions.get(sessionId);
    if (state === undefined) {
      state = { run: false, explicit: 0 };
      this.heldSessions.set(sessionId, state);
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
        if (!state.run && state.explicit === 0) this.heldSessions.delete(sessionId);
      },
    };
  }

  held(sessionId: string): boolean {
    return this.heldSessions.has(sessionId);
  }
}
