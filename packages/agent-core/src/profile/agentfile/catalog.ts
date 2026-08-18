/**
 * Session-level agent profile catalog.
 *
 * Merges the builtin (code-embedded) profiles with the file-backed sources
 * (plugin / user / extra / project / explicit) by priority, requiring an
 * explicit
 * opt-in (`override: true`) before a file replaces a same-name builtin. The
 * merged view always contains the builtin profiles (seeded at construction);
 * file profiles appear once `ready` resolves. A failing `explicit` source (an
 * invalid `--agent-file`) rejects `ready` so session creation surfaces the
 * error; a failing directory source degrades to warnings, so directory
 * problems never poison the session.
 *
 * After merging, the catalog links the delegation graph: a file profile's
 * `subagents` allowlist resolves against the merged set (an omitted allowlist
 * means "any type"), and the builtin default profile's subagent set extends
 * with every file-defined profile so the main agent can delegate to custom
 * agents.
 *
 * Semantics mirror the v2 engine's agentFileCatalog domain
 * (`packages/agent-core-v2/src/app/agentFileCatalog/`, e.g. `agentProfileSource.ts`
 * and `userFileAgentSource.ts`) — keep merge/override/delegation behavior in
 * sync across both engines.
 */

import { DEFAULT_AGENT_PROFILES } from '../default';
import type { ResolvedAgentProfile } from '../types';

import { discoverAgentFiles } from './discovery';
import { agentProfileFromFile } from './from-file';
import { resolveAgentPath } from './paths';
import { configuredAgentRoots, projectAgentRoots, userAgentRoots } from './roots';
import { loadSystemMdDefinition, systemMdProfile } from './system-file';
import { describeInactiveToolPattern, findInactiveToolPatterns } from './validate';
import {
  AgentProfileCatalogSnapshotSchema,
  type AgentFileDefinition,
  type AgentFileRoot,
  type AgentFileSource,
  type AgentProfileCatalogSnapshot,
} from './types';
import { promises as fs } from 'node:fs';
import { parseAgentFileText } from './parser';

export interface SessionAgentCatalogOptions {
  readonly workDir: string;
  /** Brand data dir (`KIMI_CODE_HOME`, default `~/.kimi-code`). */
  readonly brandHomeDir: string;
  /** OS home dir, for `~/.agents/agents` and `~` expansion. */
  readonly osHomeDir: string;
  readonly extraDirs?: readonly string[];
  readonly explicitFiles?: readonly string[];
  /** Agent directories contributed by enabled plugins (lowest file priority). */
  readonly pluginRoots?: readonly AgentFileRoot[];
  readonly warn?: (message: string, error?: unknown) => void;
}

const SOURCE_PRIORITY: Readonly<Record<AgentFileSource, number>> = {
  plugin: 5,
  user: 10,
  extra: 20,
  project: 30,
  explicit: 40,
};

export const DEFAULT_AGENT_PROFILE_NAME = 'agent';

/** Exact tool names known to the builtin profiles (MCP glob entries excluded). */
const KNOWN_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(DEFAULT_AGENT_PROFILES).flatMap((profile) =>
    profile.tools.filter((tool) => !tool.startsWith('mcp__')),
  ),
);

function isKnownBuiltinToolName(name: string): boolean {
  return KNOWN_BUILTIN_TOOL_NAMES.has(name);
}

interface FileProfileEntry {
  readonly kind: 'file' | 'system-prompt';
  readonly definition: AgentFileDefinition;
  readonly profile: ResolvedAgentProfile;
  readonly priority: number;
  readonly override: boolean;
}

/**
 * Session-local copies of the builtin profiles. `DEFAULT_AGENT_PROFILES` is a
 * process-wide constant; seeding `merged` with its values directly would let
 * any session-scoped rewrite of a profile (e.g. a host runtime projecting
 * profile tool lists onto the session's tool surface) mutate shared process
 * state and leak into every later session. Clone each entry and re-link the
 * delegation graph against the clones so the whole graph is session-local.
 */
function sessionLocalBuiltinProfiles(): Map<string, ResolvedAgentProfile> {
  const cloned = new Map<string, ResolvedAgentProfile>(
    Object.entries(DEFAULT_AGENT_PROFILES).map(([name, profile]) => [
      name,
      {
        ...profile,
        tools: [...profile.tools],
        disallowedTools:
          profile.disallowedTools === undefined ? undefined : [...profile.disallowedTools],
      },
    ]),
  );
  for (const profile of cloned.values()) {
    if (profile.subagents === undefined) continue;
    profile.subagents = Object.fromEntries(
      Object.entries(profile.subagents).map(([name, target]) => [
        name,
        cloned.get(name) ?? target,
      ]),
    );
  }
  return cloned;
}

export class SessionAgentProfileCatalog {
  private merged: Map<string, ResolvedAgentProfile>;
  private readonly readyPromise: Promise<void>;
  private snapshotValue: AgentProfileCatalogSnapshot | undefined;

  constructor(private readonly options: SessionAgentCatalogOptions) {
    this.merged = sessionLocalBuiltinProfiles();
    this.readyPromise = this.load();
    // Keep an un-awaited rejection from crashing the process; createMain /
    // spawn awaiters see the error through `ready`.
    void this.readyPromise.catch(() => undefined);
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  get(name: string): ResolvedAgentProfile | undefined {
    return this.merged.get(name);
  }

  getDefault(): ResolvedAgentProfile {
    const profile = this.get(DEFAULT_AGENT_PROFILE_NAME);
    if (profile === undefined) {
      throw new Error(
        `Default agent profile "${DEFAULT_AGENT_PROFILE_NAME}" is not registered`,
      );
    }
    return profile;
  }

  list(): readonly ResolvedAgentProfile[] {
    return [...this.merged.values()];
  }

  snapshot(): AgentProfileCatalogSnapshot | undefined {
    return this.snapshotValue === undefined
      ? undefined
      : AgentProfileCatalogSnapshotSchema.parse(this.snapshotValue);
  }

  /** Replace live discovery with the file-backed catalog bound at creation. */
  restoreSnapshot(snapshot: AgentProfileCatalogSnapshot): void {
    const restored = AgentProfileCatalogSnapshotSchema.parse(snapshot);
    const { entries } = this.entriesFromSnapshot(restored);
    this.applyFileEntries(entries);
    this.snapshotValue = restored;
  }

  /** Replace only the persisted plugin layer while keeping the session-bound local profiles. */
  async restoreSnapshotRefreshingPlugins(
    snapshot: AgentProfileCatalogSnapshot,
    pluginRoots: readonly AgentFileRoot[],
  ): Promise<void> {
    const restored = AgentProfileCatalogSnapshotSchema.parse(snapshot);
    const { effectiveDefault, entries, systemMd } = this.entriesFromSnapshot(
      restored,
      (profile) => profile.source !== 'plugin',
    );

    if (pluginRoots.length > 0) {
      const discovered = await discoverAgentFiles(pluginRoots, this.warn);
      for (const definition of discovered.agents) {
        this.warnInactivePatterns(definition);
        entries.push(this.entryFromDefinition(definition, effectiveDefault));
      }
    }

    const winners = this.applyFileEntries(entries);
    this.snapshotValue = this.snapshotFromEntries(winners, systemMd);
  }

  private entriesFromSnapshot(
    restored: AgentProfileCatalogSnapshot,
    includeProfile: (
      profile: AgentProfileCatalogSnapshot['profiles'][number],
    ) => boolean = () => true,
  ): {
    readonly effectiveDefault: ResolvedAgentProfile;
    readonly entries: FileProfileEntry[];
    readonly systemMd: AgentFileDefinition | undefined;
  } {
    this.merged = sessionLocalBuiltinProfiles();

    const builtinDefault = this.getDefault();
    const systemMd =
      restored.systemPromptTemplate === undefined
        ? undefined
        : this.snapshotSystemDefinition(restored.systemPromptTemplate);
    const effectiveDefault =
      systemMd === undefined ? builtinDefault : systemMdProfile(systemMd, builtinDefault);
    const entries: FileProfileEntry[] = [];
    if (systemMd !== undefined) {
      entries.push(this.systemMdEntry(systemMd, effectiveDefault));
    }
    for (const profile of restored.profiles) {
      if (!includeProfile(profile)) continue;
      const definition: AgentFileDefinition = {
        name: profile.name,
        description: profile.description,
        whenToUse: profile.whenToUse,
        override: true,
        tools: profile.tools,
        disallowedTools: profile.disallowedTools,
        subagents: profile.subagents,
        modelPreference: profile.modelPreference,
        prompt: profile.prompt,
        path: `<session-agent-profile:${profile.name}>`,
        source: profile.source ?? 'explicit',
      };
      entries.push(this.entryFromDefinition(definition, effectiveDefault));
    }

    return { effectiveDefault, entries, systemMd };
  }

  /**
   * The subagent types `callerProfileName` may delegate to: the caller's own
   * linked set, falling back to the default profile's set when the caller
   * declares none (mirroring the historical lookup against the builtin
   * `agent` profile).
   */
  delegatableSubagents(callerProfileName?: string): Record<string, ResolvedAgentProfile> {
    const caller = callerProfileName === undefined ? undefined : this.merged.get(callerProfileName);
    const record = caller?.subagents ?? this.getDefault().subagents;
    return record ?? {};
  }

  private async load(): Promise<void> {
    const warn = this.warn;
    const entries: FileProfileEntry[] = [];

    // ── Directory sources (non-fatal) ────────────────────────────────
    // Each source scans its own roots: a same-named file in a higher-
    // priority source must shadow, not swallow, the lower-priority one.
    const [userRoots, projectRoots, extraRoots] = await Promise.all([
      userAgentRoots(this.options.brandHomeDir, this.options.osHomeDir, warn),
      projectAgentRoots(this.options.workDir, warn),
      configuredAgentRoots(
        this.options.extraDirs ?? [],
        this.options.workDir,
        this.options.osHomeDir,
        'extra',
        warn,
      ),
    ]);

    // SYSTEM.md is pushed first: within the user source it wins the `agent`
    // name over directory files (first candidate per priority wins).
    const systemMd = await loadSystemMdDefinition(this.options.brandHomeDir, (message) =>
      warn?.(message),
    );

    // The base every file profile's `${base_prompt}` renders against — the
    // "effective default": the SYSTEM.md override when present, else the
    // builtin default. This slot is structurally disjoint from the merge
    // (only ever SYSTEM.md or builtin), so a file profile that overrides the
    // default can never recurse into itself through `${base_prompt}`. The
    // chain is at most: agent file → SYSTEM.md → builtin default.
    const builtinDefault = this.merged.get(DEFAULT_AGENT_PROFILE_NAME) ?? this.getDefault();
    const effectiveDefault =
      systemMd !== undefined ? systemMdProfile(systemMd, builtinDefault) : builtinDefault;

    if (systemMd !== undefined) {
      entries.push(this.systemMdEntry(systemMd, effectiveDefault));
    }

    for (const roots of [userRoots, extraRoots, projectRoots]) {
      if (roots.length === 0) continue;
      const discovered = await discoverAgentFiles(roots, warn);
      for (const definition of discovered.agents) {
        this.warnInactivePatterns(definition);
        entries.push(this.entryFromDefinition(definition, effectiveDefault));
      }
    }

    const pluginRoots = this.options.pluginRoots ?? [];
    if (pluginRoots.length > 0) {
      const discovered = await discoverAgentFiles(pluginRoots, warn);
      for (const definition of discovered.agents) {
        this.warnInactivePatterns(definition);
        entries.push(this.entryFromDefinition(definition, effectiveDefault));
      }
    }

    // ── Explicit source (fatal) ──────────────────────────────────────
    // Match v2's per-source merge semantics: when several explicit files
    // declare the same profile name, the last file replaces the earlier one.
    const explicitEntries = new Map<string, FileProfileEntry>();
    for (const file of this.options.explicitFiles ?? []) {
      const path = resolveAgentPath(file, this.options.workDir, this.options.osHomeDir);
      const text = await fs.readFile(path, 'utf-8');
      const definition = parseAgentFileText({ path, source: 'explicit', text });
      this.warnInactivePatterns(definition);
      explicitEntries.set(definition.name, this.entryFromDefinition(definition, effectiveDefault));
    }
    entries.push(...explicitEntries.values());

    const winners = this.applyFileEntries(entries);
    this.snapshotValue = this.snapshotFromEntries(winners, systemMd);
  }

  /**
   * Surface dead tool patterns (bare wildcards, incomplete `mcp__` literals,
   * unknown tool names) at load time, so a typo in a hand-written agent file
   * warns instead of silently shrinking the profile's tool set.
   */
  private warnInactivePatterns(definition: AgentFileDefinition): void {
    const warn = this.warn;
    if (warn === undefined) return;
    const fields: readonly (readonly [string, readonly string[] | undefined])[] = [
      ['tools', definition.tools],
      ['disallowedTools', definition.disallowedTools],
    ];
    for (const [field, patterns] of fields) {
      if (patterns === undefined) continue;
      for (const issue of findInactiveToolPatterns(patterns, isKnownBuiltinToolName)) {
        warn(`agent file ${definition.path}: ${field} entry ${describeInactiveToolPattern(issue)}`);
      }
    }
  }

  private systemMdEntry(
    definition: AgentFileDefinition,
    effectiveDefault: ResolvedAgentProfile,
  ): FileProfileEntry {
    return {
      kind: 'system-prompt',
      definition,
      profile: effectiveDefault,
      priority: SOURCE_PRIORITY['user'],
      // SYSTEM.md permanently replaces the builtin default prompt.
      override: true,
    };
  }

  private entryFromDefinition(
    definition: AgentFileDefinition,
    effectiveDefault: ResolvedAgentProfile,
  ): FileProfileEntry {
    return {
      kind: 'file',
      definition,
      profile: agentProfileFromFile(definition, effectiveDefault.tools, (context) =>
        effectiveDefault.systemPrompt(context),
      ),
      priority: SOURCE_PRIORITY[definition.source],
      override: definition.override || definition.source === 'explicit',
    };
  }

  private applyFileEntries(entries: readonly FileProfileEntry[]): readonly FileProfileEntry[] {
    const warn = this.warn;
    const merged = new Map(this.merged);
    const byName = new Map<string, FileProfileEntry[]>();
    for (const entry of [...entries].toSorted((a, b) => b.priority - a.priority)) {
      const candidates = byName.get(entry.definition.name) ?? [];
      candidates.push(entry);
      byName.set(entry.definition.name, candidates);
    }
    const winners: FileProfileEntry[] = [];
    for (const candidates of byName.values()) {
      for (const candidate of candidates) {
        if (merged.has(candidate.definition.name) && !candidate.override) {
          warn?.(
            `agent file profile "${candidate.definition.name}" ignored: a same-name builtin profile exists; set "override: true" in the frontmatter to replace it`,
          );
          continue;
        }
        merged.set(candidate.definition.name, candidate.profile);
        winners.push(candidate);
        break;
      }
    }

    // Link regular file profiles' delegation allowlists against the merged
    // set. SYSTEM.md is only a prompt overlay: treating its missing
    // frontmatter as an unrestricted allowlist would let `agent` delegate to
    // itself instead of preserving the builtin delegation policy.
    for (const winner of winners) {
      if (winner.kind === 'system-prompt') continue;
      winner.profile.subagents = this.linkSubagentAllowlist(winner.definition, merged, warn);
    }

    // Extend the builtin default — or its SYSTEM.md prompt-overlay variant —
    // with every regular file profile. A real agent file that replaced the
    // default carries its own allowlist instead.
    const defaultWinner = winners.find(
      (winner) => winner.definition.name === DEFAULT_AGENT_PROFILE_NAME,
    );
    const defaultKeepsBuiltinDelegation =
      defaultWinner === undefined || defaultWinner.kind === 'system-prompt';
    const fileWinners = winners.filter((winner) => winner.kind === 'file');
    if (defaultKeepsBuiltinDelegation && fileWinners.length > 0) {
      const defaultProfile = merged.get(DEFAULT_AGENT_PROFILE_NAME) ?? this.getDefault();
      const fileRecord: Record<string, ResolvedAgentProfile> = {};
      for (const winner of fileWinners) fileRecord[winner.definition.name] = winner.profile;
      merged.set(DEFAULT_AGENT_PROFILE_NAME, {
        ...defaultProfile,
        subagents: { ...defaultProfile.subagents, ...fileRecord },
      });
    }

    this.merged = merged;
    return winners;
  }

  private snapshotFromEntries(
    winners: readonly FileProfileEntry[],
    systemMd: AgentFileDefinition | undefined,
  ): AgentProfileCatalogSnapshot | undefined {
    const profiles = winners
      .filter((winner) => winner.definition !== systemMd)
      .map(({ definition, profile }) => ({
        name: profile.name,
        description: profile.description ?? definition.description,
        whenToUse: profile.whenToUse,
        tools: [...profile.tools],
        disallowedTools:
          profile.disallowedTools === undefined ? undefined : [...profile.disallowedTools],
        subagents: Object.keys(profile.subagents ?? {}),
        modelPreference: profile.modelPreference,
        prompt: definition.prompt,
        source: definition.source,
      }));
    if (systemMd === undefined && profiles.length === 0) return undefined;
    return AgentProfileCatalogSnapshotSchema.parse({
      version: 1,
      systemPromptTemplate: systemMd?.prompt,
      profiles,
    });
  }

  private snapshotSystemDefinition(prompt: string): AgentFileDefinition {
    return {
      name: DEFAULT_AGENT_PROFILE_NAME,
      description: '',
      override: true,
      prompt,
      path: '<session-agent-profile:SYSTEM.md>',
      source: 'user',
    };
  }

  private linkSubagentAllowlist(
    definition: AgentFileDefinition,
    merged: ReadonlyMap<string, ResolvedAgentProfile>,
    warn: ((message: string, error?: unknown) => void) | undefined,
  ): Record<string, ResolvedAgentProfile> {
    // An omitted allowlist means "any type"; a lone `*` was already
    // normalized away by the parser.
    const names = definition.subagents ?? [...merged.keys()];
    const record: Record<string, ResolvedAgentProfile> = {};
    for (const name of names) {
      const target = merged.get(name);
      if (target === undefined) {
        warn?.(
          `agent file profile "${definition.name}" declares subagent "${name}" but that agent profile was not found`,
        );
        continue;
      }
      record[name] = target;
    }
    return record;
  }

  private get warn(): ((message: string, error?: unknown) => void) | undefined {
    return this.options.warn;
  }
}
