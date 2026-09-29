import type { ProfileFinderContribution } from '../discovery/finder';
import { DEFAULT_AGENT_PROFILE_NAME, type AgentProfile } from '../definition/types';

export const BUILTIN_PROFILE_SOURCE_ID = 'builtin';

export const PRIORITY = {
  builtin: 0,
  plugin: 5,
  user: 10,
  extra: 20,
  workspace: 30,
  explicit: 40,
} as const;

export interface CatalogEntry {
  readonly sourceId: string;
  readonly priority: number;
  readonly contribution: ProfileFinderContribution;
}

export type AgentProfileSuppressedReason = 'builtin-override-required' | 'priority';

export interface AgentProfileSuppressedCandidate {
  readonly sourceId: string;
  readonly priority: number;
  readonly reason: AgentProfileSuppressedReason;
}

export interface AgentProfileInspection {
  readonly name: string;
  readonly profile: AgentProfile;
  readonly sourceId: string;
  readonly priority: number;
  readonly suppressed: readonly AgentProfileSuppressedCandidate[];
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

export interface ProfileCatalog {
  list(): readonly AgentProfile[];
  get(name: string): AgentProfile | undefined;
  getDefault(): AgentProfile;
  inspect(name: string): AgentProfileInspection | undefined;
}

export function createStaticProfileCatalog(
  profiles: readonly AgentProfile[],
): ProfileCatalog {
  return {
    list: () => profiles,
    get: (name) => profiles.find((profile) => profile.name === name),
    getDefault: () => {
      const profile =
        profiles.find((entry) => entry.name === DEFAULT_AGENT_PROFILE_NAME) ?? profiles[0];
      if (profile === undefined) {
        throw new Error(`Default agent profile "${DEFAULT_AGENT_PROFILE_NAME}" is not registered`);
      }
      return profile;
    },
    inspect: (name) => {
      const profile = profiles.find((entry) => entry.name === name);
      if (profile === undefined) return undefined;
      return {
        name,
        profile,
        sourceId: BUILTIN_PROFILE_SOURCE_ID,
        priority: PRIORITY.builtin,
        suppressed: [],
      };
    },
  };
}
