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
 * `inherit: true` entries terminate the resolution without fallback — with a
 * warning when the same entry also carries `model` or `thinking_effort`,
 * which are ignored; a stale model alias (one `modelCatalog.get` rejects,
 * whether missing or otherwise unresolvable) warns and falls through to the
 * next-lower level. Storage failures are not swallowed — they propagate to
 * the caller.
 *
 * Callers may supply an optional interactive `ask` callback — only the
 * `Agent` tool spawn path does; the swarm path never asks. When present, a
 * missing slot/type binding or a stale stored alias asks the user once and
 * adopts the (already persisted) answer as terminal; a dismissed ask falls
 * through exactly like a missing entry, keeping the stale-alias warning on
 * the repair case. One spawn asks at most once: when a slot was explicitly
 * requested, its (dismissed) ask never escalates into a second, type-level
 * question — the type binding still applies when configured, it just stays
 * silent.
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

export interface AskSubagentBindingContext {
  readonly missingModel?: string;
  readonly slot?: string;
}

export type AskSubagentSpawnBindingCallback = (
  profileName: string,
  context?: AskSubagentBindingContext,
) => Promise<SubagentBinding | undefined>;

export interface ResolveSubagentSpawnBindingDeps {
  readonly flags: IFlagService;
  readonly workspaceLocalConfig: IWorkspaceLocalConfigService;
  readonly modelCatalog: IModelCatalog;
  readonly ask?: AskSubagentSpawnBindingCallback;
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
  const explicitSlot = slot !== undefined && slot.length > 0;
  if (explicitSlot) {
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
      const asked = await askOnce(deps, input.profileName, {
        slot,
        missingModel: resolved.missingModel,
      });
      if (asked !== undefined) return withWarnings(asked, warnings);
      warnings.push(resolved.warning);
    } else {
      const asked = await askOnce(deps, input.profileName, { slot });
      if (asked !== undefined) return withWarnings(asked, warnings);
    }
  }

  const typeEntry = await deps.workspaceLocalConfig.readSubagentBinding(
    input.workDir,
    input.profileName,
  );
  const mayAsk = !explicitSlot;
  if (typeEntry !== undefined) {
    const resolved = resolveBindingEntry(
      deps,
      typeEntry,
      `subagent.${input.profileName}`,
      'the caller model',
    );
    if (resolved.terminal) return withWarnings(resolved.resolution, warnings);
    const asked = mayAsk
      ? await askOnce(deps, input.profileName, {
          missingModel: resolved.missingModel,
        })
      : undefined;
    if (asked !== undefined) return withWarnings(asked, warnings);
    warnings.push(resolved.warning);
  } else {
    const asked = mayAsk ? await askOnce(deps, input.profileName, undefined) : undefined;
    if (asked !== undefined) return withWarnings(asked, warnings);
  }

  return withWarnings({}, warnings);
}

async function askOnce(
  deps: ResolveSubagentSpawnBindingDeps,
  profileName: string,
  context: AskSubagentBindingContext | undefined,
): Promise<SubagentSpawnBindingResolution | undefined> {
  if (deps.ask === undefined) return undefined;
  const binding = await deps.ask(profileName, context);
  if (binding === undefined) return undefined;
  return adoptAskedBinding(binding);
}

function adoptAskedBinding(binding: SubagentBinding): SubagentSpawnBindingResolution {
  if (binding.inherit === true) return {};
  return { model: binding.model, thinking: binding.thinkingEffort };
}

type BindingEntryResolution =
  | { readonly terminal: true; readonly resolution: SubagentSpawnBindingResolution }
  | {
      readonly terminal: false;
      readonly warning: string;
      readonly missingModel: string;
    };

function resolveBindingEntry(
  deps: ResolveSubagentSpawnBindingDeps,
  entry: SubagentBinding,
  sectionLabel: string,
  fallbackLabel: string,
): BindingEntryResolution {
  if (entry.inherit === true) {
    const ignored: string[] = [];
    if (entry.model !== undefined) ignored.push('model');
    if (entry.thinkingEffort !== undefined) ignored.push('thinking_effort');
    if (ignored.length === 0) return { terminal: true, resolution: {} };
    return {
      terminal: true,
      resolution: {
        warning: `Subagent binding [${sectionLabel}] sets inherit=true; ignoring ${ignored.join(' and ')} set on the same entry.`,
      },
    };
  }
  if (entry.model === undefined) {
    return { terminal: true, resolution: { thinking: entry.thinkingEffort } };
  }
  try {
    deps.modelCatalog.get(entry.model);
  } catch {
    return {
      terminal: false,
      warning: `Subagent binding [${sectionLabel}] references model alias "${entry.model}" which is not configured or cannot be resolved; falling back to ${fallbackLabel}.`,
      missingModel: entry.model,
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
