/**
 * `profile` domain (L3) — wire Model (`ProfileModel`) and the `config.update`
 * Op (`configUpdate`) for the agent's persistent configuration slice.
 *
 * Declares the persistent profile config — `cwd`, `modelAlias`, `profileName`,
 * the resolved `thinkingLevel`, and `systemPrompt` — as a wire Model (initial
 * `defaultProfileModel()`), plus the single Op whose `apply` is a pure merge of
 * an already-resolved payload. `thinkingLevel` is resolved to a `ThinkingEffort`
 * at the call site (via `resolveThinkingEffort` + the `thinking` config section)
 * and carried in the payload, so `apply` stays pure and a resumed agent restores
 * the persisted resolved value rather than re-resolving against a possibly-
 * drifted config. `modelCapabilities` is intentionally NOT in the Model — it is
 * derived live from `IModelResolver` so resume never pins stale capabilities.
 * Each `apply` returns the same reference when nothing changes so the wire's
 * reference-equality gate stays quiet. The `chdir` side effect and the
 * `agent.status.updated` emission are NOT part of `apply`: they run after
 * `wire.dispatch` on the live path only, so `wire.replay` rebuilds the Model
 * silently.
 *
 * Also declares `ActiveToolsModel` (`readonly string[] | undefined`, initial
 * `undefined` = every tool active) and the `tools.set_active_tools` Op
 * (`setActiveTools`), a pure whole-set replace whose type matches the legacy
 * record so `wire.replay` restores the base set. The ephemeral per-tool
 * `addActiveTool` / `removeActiveTool` deltas (used by `userTool`) are NOT Ops —
 * they are intentionally not persisted and are re-derived on resume.
 * Consumed by the Agent-scope `profileService`.
 */

import type { ThinkingEffort } from '#/app/llmProtocol';
import { defineModel, defineOp } from '#/wire';

export interface ProfileModelState {
  readonly cwd?: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingLevel: ThinkingEffort;
  readonly systemPrompt: string;
}

export const ProfileModel = defineModel<ProfileModelState>('profile', () => ({
  thinkingLevel: 'off',
  systemPrompt: '',
}));

export interface ConfigUpdatePayload {
  readonly cwd?: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingLevel?: ThinkingEffort;
  readonly systemPrompt?: string;
}

export const configUpdate = defineOp(ProfileModel, 'config.update', {
  apply: (s, p: ConfigUpdatePayload): ProfileModelState => {
    let next: ProfileModelState | undefined;
    if (p.cwd !== undefined && p.cwd !== s.cwd) {
      next = { ...(next ?? s), cwd: p.cwd };
    }
    if (p.modelAlias !== undefined && p.modelAlias !== s.modelAlias) {
      next = { ...(next ?? s), modelAlias: p.modelAlias };
    }
    if (p.profileName !== undefined && p.profileName !== s.profileName) {
      next = { ...(next ?? s), profileName: p.profileName };
    }
    if (p.thinkingLevel !== undefined && p.thinkingLevel !== s.thinkingLevel) {
      next = { ...(next ?? s), thinkingLevel: p.thinkingLevel };
    }
    if (p.systemPrompt !== undefined && p.systemPrompt !== s.systemPrompt) {
      next = { ...(next ?? s), systemPrompt: p.systemPrompt };
    }
    return next ?? s;
  },
});

/**
 * The agent's active-tool set. `undefined` means "every tool is active" (the
 * unrestricted default before any `tools.set_active_tools`); a concrete array
 * restricts the set. Kept distinct from `[]` (which would mean "no tools
 * active"), so the initial `undefined` preserves the all-active default rather
 * than collapsing it to an empty allowlist.
 */
export type ActiveToolsState = readonly string[] | undefined;

export const ActiveToolsModel = defineModel<ActiveToolsState>(
  'profile.activeTools',
  () => undefined,
);

export interface SetActiveToolsPayload {
  readonly names: readonly string[];
}

export const setActiveTools = defineOp(ActiveToolsModel, 'tools.set_active_tools', {
  apply: (s, p: SetActiveToolsPayload): ActiveToolsState => (p.names === s ? s : p.names),
});
