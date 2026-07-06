/**
 * `swarm` domain (L4) — `IAgentSwarmService` implementation.
 *
 * Tracks swarm-mode enter/exit in the `wire` `SwarmModel` (mutated only through
 * the `swarm_mode.enter` / `swarm_mode.exit` Ops, read through `wire.getModel`),
 * mirrors it into `systemReminder` as live-only side effects, emits
 * `agent.status.updated` through `wire.signal`, and auto-exits on turn end via
 * `turn`. The reminder injection is a live-only side effect: `wire.replay`
 * rebuilds the model silently, so reminders are not re-emitted on resume
 * (matching the former `injectReminder` gate). Bound at Agent scope. The
 * `AgentSwarm` tool self-registers via `registerTool(...)` in
 * `tools/agent-swarm.ts`.
 */

import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentSystemReminderService } from '#/agent/systemReminder';
import { IAgentTurnService } from '#/agent/turn';
import { IAgentWireService, type IWireService } from '#/wire';
import SWARM_MODE_ENTER_REMINDER from './enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from './exit-reminder.md?raw';
import { IAgentSwarmService, type SwarmModeTrigger } from './swarm';
import { swarmEnter, swarmExit, SwarmModel } from './swarmOps';

export class AgentSwarmService extends Disposable implements IAgentSwarmService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentWireService private readonly wire: IWireService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentTurnService turnService: IAgentTurnService,
  ) {
    super();
    this._register(
      turnService.hooks.onEnded.register('swarm-mode-auto-exit', (_ctx, next) => {
        const done = next();
        if (this.shouldAutoExit) {
          this.exit();
        }
        return done;
      }),
    );
  }

  enter(trigger: SwarmModeTrigger): void {
    if (this.wire.getModel(SwarmModel) !== null) return;
    this.wire.dispatch(swarmEnter({ trigger }));
    if (trigger !== 'tool') {
      this.reminders.appendSystemReminder(SWARM_MODE_ENTER_REMINDER, {
        kind: 'injection',
        variant: 'swarm_mode',
      });
    }
    this.emitChanged();
  }

  exit(): void {
    const trigger = this.wire.getModel(SwarmModel);
    if (trigger === null) return;
    this.wire.dispatch(swarmExit({}));
    const removedEnterReminder =
      trigger !== 'tool' &&
      this.reminders.removeLastReminder(
        (m) => m.origin?.kind === 'injection' && m.origin.variant === 'swarm_mode',
      );
    if (trigger !== 'tool' && !removedEnterReminder) {
      this.reminders.appendSystemReminder(SWARM_MODE_EXIT_REMINDER, {
        kind: 'injection',
        variant: 'swarm_mode_exit',
      });
    }
    this.emitChanged();
  }

  get isActive(): boolean {
    return this.wire.getModel(SwarmModel) !== null;
  }

  private get shouldAutoExit(): boolean {
    const trigger = this.wire.getModel(SwarmModel);
    return trigger === 'task' || trigger === 'tool';
  }

  private emitChanged(): void {
    this.wire.signal({ type: 'agent.status.updated', swarmMode: this.isActive });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSwarmService,
  AgentSwarmService,
  InstantiationType.Delayed,
  'swarm',
);
