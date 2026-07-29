/**
 * `profile` domain (L3) — wire Model (`ProfileModel`) and the `config.update`
 * Op (`configUpdate`) for the agent's persistent configuration slice.
 *
 * Declares the persistent profile config — `cwd`, `modelAlias`, `profileName`,
 * the resolved base thinking effort, `systemPrompt`, and the profile
 * `disallowedTools` denylist and `subagents` delegation allowlist — as a wire
 * Model (initial `defaultProfileModel()`), plus the single Op whose `apply` is
 * a pure merge of an already-resolved payload. Live records carry
 * `thinkingEffort` (matching the v1 wire field); legacy replay still accepts
 * `thinkingLevel`. The value is
 * resolved to a `ThinkingEffort` at the call site (via `resolveThinkingEffort` +
 * the `thinking` config section) and carried in the payload, so `apply` stays
 * pure and a resumed agent restores the persisted base value rather than
 * re-resolving against a possibly-drifted config. Runtime-only Kimi env forcing
 * is projected by `AgentProfileService`; keeping it out of this Model prevents
 * that Kimi-only value from leaking through model switches or agent forks.
 * `modelCapabilities` is intentionally NOT in the Model — it is
 * derived live from `IModelCatalog` so resume never pins stale capabilities.
 * Each `apply` returns the same reference when nothing changes so the wire's
 * reference-equality gate stays quiet. The `chdir` side effect and the
 * `agent.status.updated` emission are NOT part of `apply`: they run after
 * `wire.dispatch` on the live path only, so `wire.replay` rebuilds the Model
 * silently.
 *
 * Also declares `ActiveToolsModel` (`readonly string[] | undefined`, initial
 * `undefined` = every tool active), the `tools.set_active_tools` whole-set
 * replace, and the v2-only `tools.reset_active_tools` transition back to the
 * unrestricted default. Both persisted transitions replay the base set. The
 * ephemeral per-tool
 * `addActiveTool` / `removeActiveTool` deltas (used by `userTool`) are NOT Ops —
 * they are intentionally not persisted and are re-derived on resume.
 * Consumed by the Agent-scope `profileService`.
 */

import { z } from 'zod';

import type { ThinkingEffort } from '#/kosong/contract/provider';
import { defineModel } from '#/wire/model';
import type { PayloadOf } from '#/wire/types';

import { ProfileError, ProfileErrors } from './profile';

export interface ProfileModelState {
  readonly cwd?: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingLevel: string;
  readonly systemPrompt: string;
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
}

export const ProfileModel = defineModel<ProfileModelState>('profile', () => ({
  thinkingLevel: 'off',
  systemPrompt: '',
}));

export const profileBind = ProfileModel.defineOp('profile.bind', {
  schema: z.object({
    cwd: z.string().optional(),
    modelAlias: z.string().optional(),
    profileName: z.string().optional(),
    thinkingEffort: z.custom<ThinkingEffort>(),
    systemPrompt: z.string(),
    activeToolNames: z.array(z.string()).readonly().optional(),
    disallowedTools: z.array(z.string()).readonly(),
    subagents: z.array(z.string()).readonly().optional(),
  }),
  apply: (s, p) => ({
    cwd: p.cwd ?? s.cwd,
    modelAlias: p.modelAlias ?? s.modelAlias,
    profileName: p.profileName ?? s.profileName,
    thinkingLevel: p.thinkingEffort,
    systemPrompt: p.systemPrompt,
    disallowedTools: p.disallowedTools,
    subagents: p.subagents,
  }),
});

export const configUpdate = ProfileModel.defineOp('config.update', {
  schema: z.object({
    cwd: z.string().optional(),
    modelAlias: z.string().optional(),
    profileName: z.string().optional(),
    thinkingEffort: z.custom<ThinkingEffort>().optional(),
    thinkingLevel: z.custom<ThinkingEffort>().optional(),
    systemPrompt: z.string().optional(),
    disallowedTools: z.array(z.string()).readonly().optional(),
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
    if (
      p.disallowedTools !== undefined &&
      !stringArrayEqual(p.disallowedTools, s.disallowedTools)
    ) {
      next = { ...(next ?? s), disallowedTools: p.disallowedTools };
    }
    return next ?? s;
  },
});

function stringArrayEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

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
  { reducers: { 'profile.bind': (_state, payload) => payload.activeToolNames } },
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'profile.bind': typeof profileBind;
    'config.update': typeof configUpdate;
    'tools.set_active_tools': typeof setActiveTools;
    'tools.reset_active_tools': typeof resetActiveTools;
  }
}

export const setActiveTools = ActiveToolsModel.defineOp('tools.set_active_tools', {
  schema: z.object({ names: z.array(z.string()).readonly() }),
  apply: (s, p) => (p.names === s ? s : p.names),
});

export const resetActiveTools = ActiveToolsModel.defineOp('tools.reset_active_tools', {
  schema: z.object({}),
  apply: (s) => (s === undefined ? s : undefined),
});
