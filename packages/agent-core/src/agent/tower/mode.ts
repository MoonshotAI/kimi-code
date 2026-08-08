import type { Agent } from '..';

/**
 * TowerMode — tracks whether this agent (always the main one) is acting as
 * the control tower of an active tower session. The heavy protocol state lives on disk in
 * `.tower/comms/state.json` via `TowerStore`; this mode object is only the
 * session-scoped on/off flag, persisted through `tower_mode.*` records so a
 * resumed session restores it (the tower tool set is restored by the
 * `tools.set_active_tools` record the same way plan/swarm state is).
 */
export class TowerMode {
  private active = false;

  constructor(protected readonly agent: Agent) {}

  enter(): void {
    if (this.active) return;
    this.agent.records.logRecord({ type: 'tower_mode.enter' });
    this.active = true;
    this.agent.emitStatusUpdated();
  }

  restoreEnter(): void {
    this.active = true;
  }

  exit(): void {
    if (!this.active) return;
    this.agent.records.logRecord({ type: 'tower_mode.exit' });
    this.active = false;
    this.agent.emitStatusUpdated();
  }

  get isActive(): boolean {
    return this.active;
  }
}
