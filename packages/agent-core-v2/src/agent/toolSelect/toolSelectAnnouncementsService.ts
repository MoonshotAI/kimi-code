/**
 * `toolSelect` domain (L4) — `IAgentToolSelectAnnouncementsService`
 * implementation.
 *
 * Appends v1-compatible loadable-tools diff announcements at turn boundaries
 * through `systemReminder`, hooks into `loop` before each step, reads
 * announcement text from `IAgentToolSelectService`, and observes compaction
 * boundaries from `event`. Turn boundaries need no state: every turn starts
 * at loop step 1, which always evaluates injection. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IEventBus } from '#/app/event/eventBus';

import { LOADABLE_TOOLS_TRIGGER } from './dynamicTools';
import { IAgentToolSelectService } from './toolSelect';
import { IAgentToolSelectAnnouncementsService } from './toolSelectAnnouncements';

export class AgentToolSelectAnnouncementsService extends Disposable implements IAgentToolSelectAnnouncementsService {
  declare readonly _serviceBrand: undefined;
  private needsBoundaryInjection = false;

  constructor(
    @IAgentToolSelectService toolSelect: IAgentToolSelectService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IEventBus eventBus: IEventBus,
    @IAgentLoopService loopService: IAgentLoopService,
  ) {
    super();
    this._register(
      eventBus.subscribe('compaction.completed', () => {
        this.needsBoundaryInjection = true;
      }),
    );
    this._register(
      loopService.hooks.onWillBeginStep.register('toolSelectAnnouncements', async (ctx, next) => {
        await next();
        if (ctx.step !== 1 && !this.needsBoundaryInjection) return;
        this.needsBoundaryInjection = false;
        this.inject(toolSelect);
      }),
    );
  }

  private inject(toolSelect: IAgentToolSelectService): void {
    const announcement = toolSelect.loadableToolsAnnouncement();
    if (announcement === undefined) return;
    this.reminders.appendSystemReminder(announcement, {
      kind: 'system_trigger',
      name: LOADABLE_TOOLS_TRIGGER,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolSelectAnnouncementsService,
  AgentToolSelectAnnouncementsService,
  InstantiationType.Eager,
  'toolSelect',
);
