/**
 * `subagent` domain (L6) — `ISessionSecondaryModelWarningService` implementation.
 *
 * When enabled through `flag`, runs the secondary-model check once per session
 * when the main agent appears (`agentLifecycle` onDidCreate, or an
 * already-present main at construction):
 * resolves the pointed entry through the kosong `modelCatalog` and, when the
 * recipe carries patch fields, checks `default_effort` against the patched
 * `supportEfforts` (what the derived entry will carry) — on failure, caches a
 * warning and publishes it as a `warning` event on the main agent's
 * `eventBus`, and stays cached for the edge to pull
 * (`GET /sessions/{id}/warnings`). Never throws: a broken secondary model
 * demotes to a notice here, with spawn-time resolution
 * (`resolveSubagentBinding` + `wrapSubagentModelError`) staying as the
 * backstop. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import {
  type IAgentScopeHandle,
  LifecycleScope,
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
import { secondaryModelPatch } from '#/app/kosongConfig/secondaryModelOverlay';
import { normalizeRequestedThinkingEffort } from '#/kosong/model/thinking';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';

import { resolveSecondaryModel } from './configSection';
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
    const secondary = resolveSecondaryModel(this.config, this.flags);
    if (secondary?.model === undefined) return undefined;
    let model: Model;
    try {
      model = this.modelCatalog.get(secondary.model);
    } catch (error) {
      return {
        code: SECONDARY_MODEL_INVALID_WARNING_CODE,
        message:
          `Secondary model "${secondary.model}" (from [secondary_model].model / ${SECONDARY_MODEL_ENV}) ` +
          `could not be resolved: ${error instanceof Error ? error.message : String(error)}. ` +
          'Subagent spawning will fail until this is fixed.',
      };
    }
    // The effort check targets what subagents actually bind: with patch
    // fields the derived entry carries the patched `supportEfforts`, without
    // them the pointed entry's own list applies.
    const patch = secondaryModelPatch(secondary);
    return effortWarning(
      secondary.model,
      secondary.defaultEffort,
      patch?.supportEfforts ?? model.supportEfforts,
    );
  }
}

function effortWarning(
  alias: string,
  effort: string | undefined,
  supportEfforts: readonly string[] | undefined,
): SecondaryModelWarning | undefined {
  const requested = normalizeRequestedThinkingEffort(effort);
  if (requested === undefined || requested === 'off' || requested === 'on') return undefined;
  const known = (supportEfforts ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (known.length === 0 || known.includes(requested)) return undefined;
  return {
    code: SECONDARY_MODEL_EFFORT_WARNING_CODE,
    message:
      `Secondary model default effort "${requested}" (from [secondary_model].default_effort / ${SECONDARY_MODEL_EFFORT_ENV}) ` +
      `is not listed for model "${alias}" (known: ${known.join(', ')}). ` +
      'Subagents may clamp or reject it.',
  };
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSecondaryModelWarningService,
  SessionSecondaryModelWarningService,
  InstantiationType.Eager,
  'subagent',
);
