import { Service } from '#/_base/di/service';
import { renderPrompt } from '#/_base/utils/render-prompt';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IFlagService } from '#/app/flag/flag';
import { TODO_LIST_TOOL_NAME } from '#/features/todo/todoItem';
import { IAgentTowerService, TOWER_FLAG_ID } from '#/features/tower/tower';
import TOWER_MODE_EXIT_REMINDER from './tower-mode-exit-reminder.md?raw';
import TOWER_MODE_FULL_REMINDER from './tower-mode-full-reminder.md?raw';
import TOWER_MODE_SPARSE_REMINDER from './tower-mode-sparse-reminder.md?raw';

const TOWER_MODE_DEDUP_MIN_TURNS = 2;
const TOWER_MODE_FULL_REFRESH_TURNS = 5;
const TOWER_MODE_INJECTION_VARIANT = 'tower_mode';
const TOWER_MODE_EXIT_DISCLOSURE = 'exit';

export class TowerModeInjection extends Service {
  constructor(
    injector: IAgentReminderService,
    @IAgentTowerService private readonly tower: IAgentTowerService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
  ) {
    super();
    this._register(
      injector.register<typeof TOWER_MODE_EXIT_DISCLOSURE>(
        TOWER_MODE_INJECTION_VARIANT,
        ({ injectedPositions, lastInjectedAt: injectedAt, lastDisclosure }) => {
          if (!this.tower.isActive) {
            if (injectedPositions.length === 0 || lastDisclosure === TOWER_MODE_EXIT_DISCLOSURE) {
              return undefined;
            }
            return {
              content: this.render(TOWER_MODE_EXIT_REMINDER),
              disclosure: TOWER_MODE_EXIT_DISCLOSURE,
            };
          }
          if (!this.flags.enabled(TOWER_FLAG_ID)) return undefined;
          if (injectedPositions.length === 0 || lastDisclosure === TOWER_MODE_EXIT_DISCLOSURE) {
            return this.render(TOWER_MODE_FULL_REMINDER);
          }
          const variant = towerModeReminderVariant(injectedAt, this.context.get());
          if (variant === 'full') return this.render(TOWER_MODE_FULL_REMINDER);
          if (variant === 'sparse') return this.render(TOWER_MODE_SPARSE_REMINDER);
          return undefined;
        },
      ),
    );
  }

  private render(template: string): string {
    const todoListActive = this.toolPolicy.isToolActive(TODO_LIST_TOOL_NAME);
    return renderPrompt(template, {
      todo_list_restored: todoListActive ? ' (including TodoList)' : '',
      todo_list_contrast: todoListActive ? ', not `TodoList`' : '',
      todo_list_denied: todoListActive ? '; TodoList is code-denied' : '',
    });
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
    if (
      message.role === 'user' &&
      message.origin?.kind !== 'injection' &&
      assistantTurnsSince >= 1
    ) {
      return 'full';
    }
  }
  if (assistantTurnsSince >= TOWER_MODE_FULL_REFRESH_TURNS) return 'full';
  if (assistantTurnsSince >= TOWER_MODE_DEDUP_MIN_TURNS) return 'sparse';
  return null;
}
