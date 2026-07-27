/**
 * `subagent` domain (L6) — `ISessionSecondaryModelWarningService` implementation.
 *
 * When enabled through `flag`, runs the subagent-model check once per session
 * when the main agent appears (`agentLifecycle` onDidCreate, or an
 * already-present main at construction):
 * resolves the pointed entry through the kosong `modelCatalog` and, when the
 * recipe carries patch fields, checks `default_effort` against the patched
 * `supportEfforts` (what the derived entry will carry) — on failure, caches a
 * warning and publishes it as a `warning` event on the main agent's
 * `eventBus`, and stays cached for the edge to pull
 * (`GET /sessions/{id}/warnings`). Never throws: a broken subagent model
 * demotes to a notice here, with spawn-time resolution
 * (`resolveSubagentBinding` + `wrapSubagentModelError`) staying as the
 * backstop. Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import {
  type IAgentScopeHandle,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import {
  SECONDARY_MODEL_EFFORT_ENV,
  SECONDARY_MODEL_ENV,
} from '#/app/kosongConfig/configSection';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { normalizeRequestedThinkingEffort } from '#/kosong/model/thinking';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';

import {
  resolveSubagentModelList,
  type ResolvedSubagentModelList,
} from './configSection';
import {
  ISessionSecondaryModelWarningService,
  SECONDARY_MODEL_EFFORT_WARNING_CODE,
  SECONDARY_MODEL_INVALID_WARNING_CODE,
  type SecondaryModelWarning,
} from './secondaryModelWarning';

export class SessionSecondaryModelWarningService
  extends Disposable
  implements ISessionSecondaryModelWarningService
{
  declare readonly _serviceBrand: undefined;

  private warning: SecondaryModelWarning | undefined;
  private checked = false;

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
  ) {
    super();
    this._register(
      this.agentLifecycle.onDidCreate((handle) => {
        if (handle.id === MAIN_AGENT_ID) this.check(handle);
      }),
    );
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (main !== undefined) this.check(main);
  }

  getSecondaryModelWarning(): SecondaryModelWarning | undefined {
    return this.warning;
  }

  private check(main: IAgentScopeHandle): void {
    if (this.checked) return;
    this.checked = true;
    this.warning = this.computeWarning();
    if (this.warning !== undefined) {
      main.accessor.get(IEventBus).publish({
        type: 'warning',
        code: this.warning.code,
        message: this.warning.message,
      });
    }
  }

  private computeWarning(): SecondaryModelWarning | undefined {
    let slots: ResolvedSubagentModelList;
    try {
      slots = resolveSubagentModelList(this.config, this.flags);
    } catch (error) {
      return {
        code: SECONDARY_MODEL_INVALID_WARNING_CODE,
        message:
          `Subagent model configuration could not be resolved: ` +
          formatWarningReason(error),
      };
    }
    if (slots === null) return undefined;

    for (const slot of slots) {
      let model: Model;
      try {
        model = this.modelCatalog.get(slot.baseModel);
      } catch (error) {
        const source =
          slot.source === 'legacy-secondary'
            ? `[secondary_model].model / ${SECONDARY_MODEL_ENV}`
            : `[subagent_models.${slot.name}].model`;
        return {
          code: SECONDARY_MODEL_INVALID_WARNING_CODE,
          message:
            `Subagent model slot "${slot.name}" points at "${slot.baseModel}"` +
            ` (from ${source}) which could not be resolved:` +
            ` ${formatWarningReason(error)} ` +
            'Subagent spawning will fail until this is fixed.',
        };
      }
      const eff = effortWarning(
        slot.baseModel,
        slot.thinking,
        slot.patchedSupportEfforts ?? model.supportEfforts,
        slot.source === 'legacy-secondary'
          ? { section: '[secondary_model].default_effort', env: SECONDARY_MODEL_EFFORT_ENV }
          : { section: `[subagent_models.${slot.name}].default_effort` },
      );
      if (eff !== undefined) return eff;
    }
    return undefined;
  }
}

function formatWarningReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

interface EffortWarningSource {
  section: string;
  env?: string;
}

function effortWarning(
  alias: string,
  effort: string | undefined,
  supportEfforts: readonly string[] | undefined,
  source: EffortWarningSource,
): SecondaryModelWarning | undefined {
  const requested = normalizeRequestedThinkingEffort(effort);
  if (requested === undefined || requested === 'off' || requested === 'on') return undefined;
  const known = (supportEfforts ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (known.length === 0 || known.includes(requested)) return undefined;
  const origin =
    source.env !== undefined
      ? `${source.section} / ${source.env}`
      : source.section;
  return {
    code: SECONDARY_MODEL_EFFORT_WARNING_CODE,
    message:
      `Subagent model effort "${requested}" (from ${origin}) ` +
      `is not listed for model "${alias}" (known: ${known.join(', ')}). ` +
      'Subagents may clamp or reject it.',
  };
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSecondaryModelWarningService,
  SessionSecondaryModelWarningService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);
