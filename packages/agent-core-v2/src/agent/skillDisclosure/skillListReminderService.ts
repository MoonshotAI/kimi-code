/**
 * `skillDisclosure` domain (L4) — skill-list reminder provider.
 *
 * Registers through `contextInjector`, applies the active `toolPolicy`, and
 * compares structured snapshots from `skillDisclosure`; additions emit the
 * full superseding listing and record a typed disclosure on the injection.
 * The baseline — what the model has already seen — prefers the typed
 * disclosure on the newest surviving `skill_list` injection, then the
 * persisted floor (the wire model's disclosed names plus the render
 * generation that wrote them). When no baseline exists at all, the current
 * names are adopted silently as the floor at the current generation. Bound
 * at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionResult,
} from '#/agent/contextInjector/contextInjector';
import {
  disclosureOfKind,
  pickDisclosureBaseline,
} from '#/agent/contextInjector/disclosureBaseline';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';

import {
  IAgentSkillDisclosureService,
  type SkillDisclosureFloor,
} from './skillDisclosure';
import { IAgentSkillListReminderService } from './skillListReminder';

const SKILL_LIST_INJECTION_VARIANT = 'skill_list';

export class AgentSkillListReminderService extends Disposable implements IAgentSkillListReminderService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService contextInjector: IAgentContextInjectorService,
    @IAgentSkillDisclosureService private readonly disclosure: IAgentSkillDisclosureService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
  ) {
    super();
    this._register(
      contextInjector.register(SKILL_LIST_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private async reminder({
    lastDisclosure,
  }: ContextInjectionContext): Promise<ContextInjectionResult | undefined> {
    try {
      if (!this.toolPolicy.isToolActive('Skill')) return undefined;
      const current = await this.disclosure.resolve(true);
      const renderGeneration = this.profile.data().renderGeneration ?? 0;
      const baseline = pickDisclosureBaseline<SkillDisclosureFloor>(
        disclosureOfKind(lastDisclosure, 'skills'),
        this.disclosure.disclosedFloor(),
      );
      if (baseline === undefined) {
        this.disclosure.markDisclosed(current.names, renderGeneration);
        return undefined;
      }
      if (!current.names.some((name) => !baseline.names.includes(name))) {
        return undefined;
      }
      return {
        content: buildSkillListReminder(current.listing),
        disclosure: {
          kind: 'skills',
          renderGeneration,
          names: current.names,
        },
      };
    } catch {
      return undefined;
    }
  }
}

function buildSkillListReminder(listing: string): string {
  return `The skill list has changed since your system prompt was rendered; new skills are available. The listing below is the current source of truth.\n\n${listing}\n\nDO NOT mention this to the user explicitly.`;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillListReminderService,
  AgentSkillListReminderService,
  ScopeActivation.OnScopeCreated,
  'skillDisclosure',
);
