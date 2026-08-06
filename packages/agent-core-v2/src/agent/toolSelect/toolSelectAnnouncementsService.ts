/**
 * `toolSelect` domain — `IAgentToolSelectAnnouncementsService`
 * implementation.
 *
 * Registers v1-compatible loadable-tools diff announcements as a
 * `contextInjector` provider (variant `loadable-tools`). The injector's
 * `isNewTurn` covers exactly the old boundary set — every turn's first step
 * and the post-compaction inject — so no local boundary state is needed.
 * Reads announcement text from `IAgentToolSelectService`; the folded history
 * itself remains the ledger, so undo/compaction/resume all self-heal by
 * re-folding. Bound at Agent scope.
 */

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';

import { LOADABLE_TOOLS_VARIANT } from './dynamicTools';
import { IAgentToolSelectService } from './toolSelect';
import { IAgentToolSelectAnnouncementsService } from './toolSelectAnnouncements';

export class AgentToolSelectAnnouncementsService extends Service implements IAgentToolSelectAnnouncementsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolSelectService toolSelect: IAgentToolSelectService,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
  ) {
    super();
    this._register(
      injector.register(LOADABLE_TOOLS_VARIANT, ({ isNewTurn }) =>
        isNewTurn ? toolSelect.loadableToolsAnnouncement() : undefined,
      ),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolSelectAnnouncementsService,
  AgentToolSelectAnnouncementsService,
  ScopeActivation.OnScopeCreated,
  'toolSelect',
);
