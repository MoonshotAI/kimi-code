import type { BrowserControlPresentation } from '../../shared/browser-control';
import type { BrowserSubagentRun } from '../../shared/browser-run';
import { trySendDesktopEvent } from '../diagnostics/track';

export class BrowserControlError extends Error {
  constructor(readonly code: 'BROWSER_USER_TAKEOVER' | 'BROWSER_SUBAGENT_UNAVAILABLE' | 'PAGE_NOT_READY' | 'TAB_NOT_ACTIVE', message: string) {
    super(message);
  }
}

interface BlockedController {
  sessionId: string;
  run?: BrowserSubagentRun;
  userTakeover?: boolean;
}

export class BrowserControlOwnershipState {
  private sessions = new Map<string, string>();
  private active = new Map<string, BrowserControlPresentation>();
  private blocked = new Map<string, BlockedController>();
  private revisions = new Map<string, number>();
  private takeoverRevisions = new Map<string, number>();
  private turns = new Map<string, string>();
  private clocks = new Map<string, { startedAt: number; pausedAt: number | null }>();
  private agentClosing = new Map<string, number>();

  private key(sessionId: string, run?: BrowserSubagentRun): string {
    return run === undefined
      ? `session:${sessionId}`
      : `run:${sessionId}:${run.agentId}:${run.generation}:${run.turnId}`;
  }

  private controlKeyFor(control: BrowserControlPresentation): string {
    return this.key(control.sessionId, control.controller?.run);
  }

  sync(controls: BrowserControlPresentation[], now = Date.now()): void {
    const active = new Map<string, BrowserControlPresentation>();
    for (const control of controls) {
      this.sessions.set(control.browserId, control.sessionId);
      if (control.controller === undefined) this.observeTurn(control.sessionId, control.turnId);
      if (control.status !== 'idle' && (control.controller !== undefined || control.turnId !== null)) {
        active.set(control.sessionId, control);
      }
    }
    for (const [sessionId, previous] of this.active) {
      const next = active.get(sessionId);
      const previousKey = this.controlKeyFor(previous);
      const nextKey = next === undefined ? undefined : this.controlKeyFor(next);
      if (previousKey === nextKey) continue;
      if (previous.controller !== undefined || next?.controller !== undefined) {
        this.revisions.set(previousKey, (this.revisions.get(previousKey) ?? 0) + 1);
      }
      this.clocks.delete(previousKey);
      if (nextKey !== undefined) this.clocks.delete(nextKey);
    }
    const activeKeys = new Set([...active.values()].map(control => this.controlKeyFor(control)));
    for (const key of this.clocks.keys()) if (!activeKeys.has(key)) this.clocks.delete(key);
    for (const control of active.values()) {
      const key = this.controlKeyFor(control);
      let clock = this.clocks.get(key);
      if (clock === undefined) {
        clock = { startedAt: now, pausedAt: null };
        this.clocks.set(key, clock);
      }
      if (control.status === 'running') {
        if (clock.pausedAt !== null) clock.startedAt += now - clock.pausedAt;
        clock.pausedAt = null;
      } else clock.pausedAt ??= now;
    }
    this.active = active;
  }

  sessionFor(browserId: string): string | undefined { return this.sessions.get(browserId); }
  revision(sessionId: string | undefined, run?: BrowserSubagentRun): number {
    return sessionId === undefined ? 0 : this.revisions.get(this.key(sessionId, run)) ?? 0;
  }
  controlKey(browserId: string): string | undefined {
    const sessionId = this.sessions.get(browserId);
    const control = sessionId === undefined ? undefined : this.active.get(sessionId);
    if (sessionId === undefined || control === undefined || !this.clocks.has(this.controlKeyFor(control))) return undefined;
    const run = control.controller?.run;
    return run === undefined
      ? `${sessionId}:${control.turnId ?? ''}`
      : `${sessionId}:${run.agentId}:${run.generation}:${run.turnId}`;
  }
  startedAt(sessionId: string, run?: BrowserSubagentRun): number {
    return this.clocks.get(this.key(sessionId, run))?.startedAt ?? Date.now();
  }
  isBlocked(sessionId: string | undefined, run?: BrowserSubagentRun): boolean {
    return sessionId !== undefined && this.blocked.has(this.key(sessionId, run));
  }

  takeOver(browserId: string): boolean {
    const sessionId = this.sessions.get(browserId);
    const control = sessionId === undefined ? undefined : this.active.get(sessionId);
    if (sessionId === undefined || control === undefined) return false;
    const run = control.controller?.run;
    const key = this.key(sessionId, run);
    const revoked = this.revoke(sessionId, run);
    this.blocked.set(key, { sessionId, run, userTakeover: true });
    if (revoked) this.takeoverRevisions.set(key, this.revision(sessionId, run));
    return revoked;
  }

  restoreRevokedRuns(): boolean {
    let restored = false;
    for (const [key, item] of this.blocked) {
      if (item.run === undefined || item.userTakeover === true) continue;
      this.blocked.delete(key);
      restored = true;
    }
    return restored;
  }

  revoke(sessionId: string, run?: BrowserSubagentRun): boolean {
    const key = this.key(sessionId, run);
    if (this.blocked.has(key)) return false;
    this.blocked.set(key, { sessionId, run });
    this.revisions.set(key, this.revision(sessionId, run) + 1);
    this.clocks.delete(key);
    return true;
  }

  expectAgentClose(browserId: string): () => void {
    this.agentClosing.set(browserId, (this.agentClosing.get(browserId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.agentClosing.get(browserId) ?? 1) - 1;
      if (remaining > 0) this.agentClosing.set(browserId, remaining);
      else this.agentClosing.delete(browserId);
    };
  }

  isAgentClosing(browserId: string): boolean { return this.agentClosing.has(browserId); }

  observeTurn(sessionId: string, turnId: string | null): void {
    if (turnId === null) return;
    const previous = this.turns.get(sessionId);
    this.turns.set(sessionId, turnId);
    if (previous !== undefined && previous !== turnId) {
      const key = this.key(sessionId);
      if (this.blocked.delete(key)) trySendDesktopEvent('browser_control_changed', { action: 'handback', trigger: 'new_turn', session_id: sessionId });
      this.revisions.set(key, this.revision(sessionId) + 1);
      this.clocks.delete(key);
    }
  }

  assertAllowed(sessionId: string | undefined, revision?: number, run?: BrowserSubagentRun, allowRelease = false): void {
    const currentRevision = this.revision(sessionId, run);
    const ownRelease = allowRelease && revision !== undefined && currentRevision === revision + 1 && sessionId !== undefined && !this.active.has(sessionId);
    const takeoverRevision = sessionId === undefined ? undefined : this.takeoverRevisions.get(this.key(sessionId, run));
    if (this.isBlocked(sessionId, run) || (revision !== undefined && takeoverRevision !== undefined && revision < takeoverRevision)) {
      throw new BrowserControlError('BROWSER_USER_TAKEOVER', 'The user has manually taken over the browser. Stop browser actions and ask the user what they would like to do next. Do not retry or reacquire control during this turn. Browser control is available again when the user starts a new turn.');
    }
    if (revision !== undefined && revision !== currentRevision && !ownRelease) {
      throw new BrowserControlError('TAB_NOT_ACTIVE', 'Browser control changed; request a new operation under the current control.');
    }
  }

  snapshot() {
    const blocked = [...this.blocked.values()];
    const sessionIds = [...new Set(blocked.filter(item => item.run === undefined).map(item => item.sessionId))];
    const runs = blocked.flatMap(item => item.run === undefined ? [] : [{ sessionId: item.sessionId, run: item.run }]);
    const browserIds = [...this.sessions].flatMap(([browserId, sessionId]) => {
      const control = this.active.get(sessionId);
      return control !== undefined && this.blocked.has(this.controlKeyFor(control)) ? [browserId] : [];
    });
    return { sessionIds, runs, browserIds };
  }

  reset(): void {
    this.sessions.clear();
    this.active.clear();
    this.blocked.clear();
    this.revisions.clear();
    this.takeoverRevisions.clear();
    this.turns.clear();
    this.clocks.clear();
    this.agentClosing.clear();
  }
}

export const browserControlOwnership = new BrowserControlOwnershipState();
