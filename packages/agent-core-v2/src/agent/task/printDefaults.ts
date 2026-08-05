/**
 * `task` domain — print-mode (`kimi -p`) config-section defaults.
 *
 * A headless run should not be cut short by limits meant for interactive use, so every filled value
 * is "effectively unbounded". Fills land in the config memory layer via
 * `IConfigService.set(…, ConfigTarget.Memory)`, never on disk.
 *
 * Only keys the user left unset are filled. A key counts as set when it has a
 * user-config value (for `bashTaskTimeoutS`, in either `[task]` or the legacy
 * `[background]` section), a memory-layer value, or an env-overlay value (an
 * effective value with no user/memory source and different from the section
 * default). Because the memory layer shadows a whole section on read, each
 * patch spreads the section's current effective value so sibling user keys
 * stay visible. Explicit user config always wins over these defaults.
 */

import { ConfigTarget, type ConfigInspectValue, type IConfigService } from '#/app/config/config';
import { LOOP_CONTROL_SECTION } from '#/agent/loop/configSection';
import { SUBAGENT_SECTION } from '#/session/subagent/configSection';

import { LEGACY_BACKGROUND_SECTION, TASK_SECTION } from './configSection';

export const PRINT_WAIT_CEILING_S_DEFAULT = 315_360_000;

export const PRINT_MAX_TURNS_DEFAULT = 100_000;

export const PRINT_BASH_TASK_TIMEOUT_S_DEFAULT = 0;

export const PRINT_SUBAGENT_TIMEOUT_MS_DEFAULT = 0;

type SectionValue = Record<string, unknown>;

function isUnset(inspected: ConfigInspectValue<SectionValue>, key: string): boolean {
  if (inspected.userValue?.[key] !== undefined) return false;
  if (inspected.memoryValue?.[key] !== undefined) return false;
  const effective = inspected.value?.[key];
  if (effective === undefined) return true;
  return inspected.defaultValue?.[key] === effective;
}

async function fillSectionDefault(
  config: IConfigService,
  domain: string,
  key: string,
  value: number,
  legacyUserValue?: SectionValue,
): Promise<void> {
  const inspected = config.inspect<SectionValue>(domain);
  if (!isUnset(inspected, key)) return;
  if (legacyUserValue?.[key] !== undefined) return;
  await config.set(domain, { ...inspected.value, [key]: value }, ConfigTarget.Memory);
}

export async function applyPrintModeConfigDefaults(config: IConfigService): Promise<void> {
  await fillSectionDefault(
    config,
    TASK_SECTION,
    'bashTaskTimeoutS',
    PRINT_BASH_TASK_TIMEOUT_S_DEFAULT,
    config.inspect<SectionValue>(LEGACY_BACKGROUND_SECTION).userValue,
  );
  await fillSectionDefault(config, LOOP_CONTROL_SECTION, 'maxStepsPerTurn', 0);
  await fillSectionDefault(
    config,
    SUBAGENT_SECTION,
    'timeoutMs',
    PRINT_SUBAGENT_TIMEOUT_MS_DEFAULT,
  );
}
