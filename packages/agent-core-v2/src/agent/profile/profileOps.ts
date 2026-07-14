/**
 * `profile` domain (L3) — wire Model (`ProfileModel`) and the `config.update`
 * Op (`configUpdate`) for the agent's persistent configuration slice.
 *
 * Declares the persistent profile config — `cwd`, `modelAlias`, `profileName`,
 * the resolved thinking effort, and `systemPrompt` — as a wire Model (initial
 * `defaultProfileModel()`), plus the single Op whose `apply` is a pure merge of
 * an already-resolved payload. Live records carry `thinkingEffort` (matching
 * the v1 wire field); legacy replay still accepts `thinkingLevel`. The value is
 * resolved to a `ThinkingEffort` at the call site (via `resolveThinkingEffort` +
 * the `thinking` config section) and carried in the payload, so `apply` stays
 * pure and a resumed agent restores
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

import { z } from 'zod';

import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import { defineModel } from '#/wire/model';
import type { PayloadOf } from '#/wire/types';

import { ProfileError, ProfileErrors } from './profile';

export interface ProfileModelState {
  readonly cwd?: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingLevel: string;
  readonly systemPrompt: string;
}

export const ProfileModel = defineModel<ProfileModelState>('profile', () => ({
  thinkingLevel: 'off',
  systemPrompt: '',
}));

export const configUpdate = ProfileModel.defineOp('config.update', {
  schema: z.object({
    cwd: z.string().optional(),
    modelAlias: z.string().optional(),
    profileName: z.string().optional(),
    thinkingEffort: z.custom<ThinkingEffort>().optional(),
    thinkingLevel: z.custom<ThinkingEffort>().optional(),
    systemPrompt: z.string().optional(),
  }),
  apply: (s, p) => {
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
    const thinkingLevel = configUpdateThinkingLevel(p);
    if (thinkingLevel !== undefined && thinkingLevel !== s.thinkingLevel) {
      next = { ...(next ?? s), thinkingLevel };
    }
    if (p.systemPrompt !== undefined && p.systemPrompt !== s.systemPrompt) {
      next = { ...(next ?? s), systemPrompt: p.systemPrompt };
    }
    return next ?? s;
  },
});

function configUpdateThinkingLevel(
  p: PayloadOf<typeof configUpdate>,
): ThinkingEffort | undefined {
  if (p.thinkingEffort !== undefined && p.thinkingLevel !== undefined) {
    if (p.thinkingEffort !== p.thinkingLevel) {
      throw new ProfileError(
        ProfileErrors.codes.THINKING_ALIAS_CONFLICT,
        `config.update has conflicting thinkingEffort (${p.thinkingEffort}) and legacy thinkingLevel (${p.thinkingLevel})`,
        {
          type: 'config.update',
          thinkingEffort: p.thinkingEffort,
          thinkingLevel: p.thinkingLevel,
        },
      );
    }
    return p.thinkingEffort;
  }
  if (p.thinkingEffort !== undefined) return p.thinkingEffort;
  return p.thinkingLevel;
}

export type ActiveToolsState = readonly string[] | undefined;

export const ActiveToolsModel = defineModel<ActiveToolsState>(
  'profile.activeTools',
  () => undefined,
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'config.update': typeof configUpdate;
    'tools.set_active_tools': typeof setActiveTools;
  }
}

export const setActiveTools = ActiveToolsModel.defineOp('tools.set_active_tools', {
  schema: z.object({ names: z.array(z.string()).readonly() }),
  apply: (s, p) => (p.names === s ? s : p.names),
});
