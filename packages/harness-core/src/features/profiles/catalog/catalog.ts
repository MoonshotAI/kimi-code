import {
  BUILTIN_PROFILE_SOURCE_ID,
  type AgentProfile,
  type AgentProfileInspection,
  type AgentProfileSuppressedCandidate,
} from '#/features/spawn/index';

import type { ProfileFinderContribution } from '../discovery/finder';

export { BUILTIN_PROFILE_SOURCE_ID, PRIORITY, createStaticProfileCatalog } from '#/features/spawn/index';
export type {
  AgentProfileInspection,
  AgentProfileSuppressedCandidate,
  AgentProfileSuppressedReason,
  ProfileCatalog,
} from '#/features/spawn/index';

export interface CatalogEntry {
  readonly sourceId: string;
  readonly priority: number;
  readonly contribution: ProfileFinderContribution;
}

export interface CatalogView {
  readonly merged: ReadonlyMap<string, AgentProfile>;
  readonly inspections: ReadonlyMap<string, AgentProfileInspection>;
}

interface ProfileCandidate {
  readonly profile: AgentProfile;
  readonly sourceId: string;
  readonly priority: number;
}

export function buildCatalogView(
  entries: readonly CatalogEntry[],
  warn?: (message: string) => void,
): CatalogView {
  const merged = new Map<string, AgentProfile>();
  const inspections = new Map<string, AgentProfileInspection>();

  const builtinEntry = entries.find((e) => e.sourceId === BUILTIN_PROFILE_SOURCE_ID);
  if (builtinEntry !== undefined) {
    for (const profile of builtinEntry.contribution.profiles) {
      merged.set(profile.name, profile);
      inspections.set(profile.name, {
        name: profile.name,
        profile,
        sourceId: builtinEntry.sourceId,
        priority: builtinEntry.priority,
        suppressed: [],
      });
    }
  }

  const fileCandidates = new Map<string, ProfileCandidate[]>();
  const ordered = entries
    .filter((e) => e.sourceId !== BUILTIN_PROFILE_SOURCE_ID)
    .toSorted((a, b) => b.priority - a.priority);
  for (const entry of ordered) {
    const entryProfiles = new Map<string, AgentProfile>();
    for (const profile of entry.contribution.profiles) {
      entryProfiles.set(profile.name, profile);
    }
    for (const profile of entryProfiles.values()) {
      const candidates = fileCandidates.get(profile.name) ?? [];
      candidates.push({
        profile,
        sourceId: entry.sourceId,
        priority: entry.priority,
      });
      fileCandidates.set(profile.name, candidates);
    }
  }

  for (const candidates of fileCandidates.values()) {
    const suppressed: AgentProfileSuppressedCandidate[] = [];
    let winner = false;
    for (const candidate of candidates) {
      if (merged.has(candidate.profile.name) && candidate.profile.override !== true) {
        warn?.(
          `agent file profile "${candidate.profile.name}" ignored: a same-name builtin profile exists; set "override: true" in the frontmatter to replace it`,
        );
        suppressed.push({
          sourceId: candidate.sourceId,
          priority: candidate.priority,
          reason: 'builtin-override-required',
        });
        continue;
      }
      const replaced = merged.get(candidate.profile.name);
      const effective =
        candidate.profile.subagents === undefined && replaced?.subagents !== undefined
          ? { ...candidate.profile, subagents: replaced.subagents }
          : candidate.profile;
      merged.set(candidate.profile.name, effective);
      inspections.set(candidate.profile.name, {
        name: candidate.profile.name,
        profile: effective,
        sourceId: candidate.sourceId,
        priority: candidate.priority,
        suppressed: [
          ...suppressed,
          ...candidates.slice(candidates.indexOf(candidate) + 1).map((rest) => ({
            sourceId: rest.sourceId,
            priority: rest.priority,
            reason: 'priority' as const,
          })),
        ],
      });
      winner = true;
      break;
    }
    if (!winner && suppressed.length > 0) {
      const name = candidates[0]?.profile.name;
      const existing = name === undefined ? undefined : inspections.get(name);
      if (existing !== undefined) {
        inspections.set(existing.name, { ...existing, suppressed });
      }
    }
  }

  return { merged, inspections };
}
