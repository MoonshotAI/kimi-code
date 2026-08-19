import { Service } from '#/_base/di/service';
import { defineState } from '#/state/state';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentTowerService } from '#/features/tower/tower';
import { IAgentStateService } from '#/agent/state/agentState';
import TOWER_MODE_EXIT_REMINDER from './tower-mode-exit-reminder.md?raw';
import TOWER_MODE_FULL_REMINDER from './tower-mode-full-reminder.md?raw';
import TOWER_MODE_SPARSE_REMINDER from './tower-mode-sparse-reminder.md?raw';

const TOWER_MODE_DEDUP_MIN_TURNS = 2;
const TOWER_MODE_FULL_REFRESH_TURNS = 5;
const TOWER_MODE_INJECTION_VARIANT = 'tower_mode';

export const towerWasActiveKey = defineState<boolean>('tower.wasActive', () => false);

export class TowerModeInjection extends Service {
  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentTowerService private readonly tower: IAgentTowerService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(towerWasActiveKey);

    this._register(
      injector.register(TOWER_MODE_INJECTION_VARIANT, ({ lastInjectedAt: injectedAt }) => {
        if (!this.tower.isActive) {
          if (!this.states.get(towerWasActiveKey)) return undefined;
          this.states.set(towerWasActiveKey, false);
          return TOWER_MODE_EXIT_REMINDER;
        }
        if (!this.states.get(towerWasActiveKey)) {
          this.states.set(towerWasActiveKey, true);
          return TOWER_MODE_FULL_REMINDER;
        }
        const variant = towerModeReminderVariant(injectedAt, this.context.get());
        if (variant === 'full') return TOWER_MODE_FULL_REMINDER;
        if (variant === 'sparse') return TOWER_MODE_SPARSE_REMINDER;
        return undefined;
      }),
    );
  }
}

type TowerModeReminderVariant = 'full' | 'sparse';

function towerModeReminderVariant(
  injectedAt: number | null,
  history: readonly ContextMessage[],
): TowerModeReminderVariant | null {
  if (injectedAt === null) return 'full';
  let assistantTurnsSince = 0;
  for (let i = injectedAt + 1; i < history.length; i++) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.role === 'assistant') {
      assistantTurnsSince += 1;
      continue;
    }
    if (message.role === 'user') {
      return 'full';
    }
  }
  if (assistantTurnsSince >= TOWER_MODE_FULL_REFRESH_TURNS) return 'full';
  if (assistantTurnsSince >= TOWER_MODE_DEDUP_MIN_TURNS) return 'sparse';
  return null;
}
