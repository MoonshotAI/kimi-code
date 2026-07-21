/**
 * `subagent` domain (L6) — spawn-time workspace model binding resolution.
 *
 * Pure-function module (no scoped state; services arrive as parameters) that
 * resolves the effective model/thinking overrides for one subagent spawn
 * from the `.kimi-code/local.toml` binding tables: a named slot
 * (`[subagent-slot.<name>]`) wins over the type binding
 * (`[subagent.<type>]`), and both fall back to inheriting the caller model
 * (an empty resolution). Gated by the `subagent-model-selection`
 * experimental flag — while disabled the resolution is always empty, so the
 * spawn points behave exactly as they did before bindings existed.
 * `inherit: true` entries terminate the resolution without fallback; a stale
 * model alias (one `modelCatalog.get` rejects) warns and falls through to
 * the next-lower level. Storage failures are not swallowed — they propagate
 * to the caller.
 */

import { IFlagService } from '#/app/flag/flag';
import {
  type IWorkspaceLocalConfigService,
  type SubagentBinding,
} from '#/app/workspaceLocalConfig/workspaceLocalConfig';
import { type IModelCatalog } from '#/kosong/model/catalog';

import { SUBAGENT_MODEL_SELECTION_FLAG_ID } from './flag';

export interface SubagentSpawnBindingResolution {
  readonly model?: string;
  readonly thinking?: string;
  readonly warning?: string;
}

export interface ResolveSubagentSpawnBindingDeps {
  readonly flags: IFlagService;
  readonly workspaceLocalConfig: IWorkspaceLocalConfigService;
  readonly modelCatalog: IModelCatalog;
}

export interface ResolveSubagentSpawnBindingInput {
  readonly workDir: string;
  readonly profileName: string;
  readonly bindingSlot?: string;
}

export async function resolveSubagentSpawnBinding(
  deps: ResolveSubagentSpawnBindingDeps,
  input: ResolveSubagentSpawnBindingInput,
): Promise<SubagentSpawnBindingResolution> {
  if (!deps.flags.enabled(SUBAGENT_MODEL_SELECTION_FLAG_ID)) return {};

  const warnings: string[] = [];
  const slot = input.bindingSlot?.trim();
  if (slot !== undefined && slot.length > 0) {
    const slotEntry = await deps.workspaceLocalConfig.readSubagentSlotBinding(
      input.workDir,
      slot,
    );
    if (slotEntry !== undefined) {
      const resolved = resolveBindingEntry(
        deps,
        slotEntry,
        `subagent-slot.${slot}`,
        'the type binding',
      );
      if (resolved.terminal) return withWarnings(resolved.resolution, warnings);
      warnings.push(resolved.warning);
    }
  }

  const typeEntry = await deps.workspaceLocalConfig.readSubagentBinding(
    input.workDir,
    input.profileName,
  );
  if (typeEntry !== undefined) {
    const resolved = resolveBindingEntry(
      deps,
      typeEntry,
      `subagent.${input.profileName}`,
      'the caller model',
    );
    if (resolved.terminal) return withWarnings(resolved.resolution, warnings);
    warnings.push(resolved.warning);
  }

  return withWarnings({}, warnings);
}

type BindingEntryResolution =
  | { readonly terminal: true; readonly resolution: SubagentSpawnBindingResolution }
  | { readonly terminal: false; readonly warning: string };

function resolveBindingEntry(
  deps: ResolveSubagentSpawnBindingDeps,
  entry: SubagentBinding,
  sectionLabel: string,
  fallbackLabel: string,
): BindingEntryResolution {
  if (entry.inherit === true) {
    return { terminal: true, resolution: {} };
  }
  if (entry.model === undefined) {
    return { terminal: true, resolution: { thinking: entry.thinkingEffort } };
  }
  try {
    deps.modelCatalog.get(entry.model);
  } catch {
    return {
      terminal: false,
      warning: `Subagent binding [${sectionLabel}] references model alias "${entry.model}" which is not configured; falling back to ${fallbackLabel}.`,
    };
  }
  return {
    terminal: true,
    resolution: { model: entry.model, thinking: entry.thinkingEffort },
  };
}

function withWarnings(
  resolution: SubagentSpawnBindingResolution,
  warnings: readonly string[],
): SubagentSpawnBindingResolution {
  if (warnings.length === 0) return resolution;
  const warning = [...warnings, resolution.warning]
    .filter((line): line is string => line !== undefined)
    .join(' ');
  return { ...resolution, warning };
}
