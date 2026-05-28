import { renderPrompt } from '../utils/render-prompt';
import type {
  RawAgentProfile,
  RawSubagentProfile,
  ResolvedAgentProfile,
  SystemPromptContext,
  SystemPromptRenderer,
} from './types';

interface MergedAgentProfile {
  readonly name: string;
  readonly description?: string | undefined;
  readonly systemPromptTemplate: string;
  readonly promptVars: Record<string, string>;
  readonly tools: string[];
  readonly whenToUse?: string | undefined;
  readonly subagents?: Record<string, RawSubagentProfile> | undefined;
}

/**
 * Resolve agent profiles with extends inheritance.
 *
 * Each resolved profile exposes its `systemPrompt` as a renderer that
 * closes over the merged template and prompt vars. The renderer is
 * invoked later with a {@link SystemPromptContext} to produce the
 * concrete prompt — this lets context that only exists at runtime
 * (cwd listing, AGENTS.md, skills) flow through without re-loading
 * profiles.
 */
export function resolveAgentProfiles(
  raw: readonly RawAgentProfile[],
): Record<string, ResolvedAgentProfile> {
  const profileMap = new Map<string, RawAgentProfile>();
  const mergedCache = new Map<string, MergedAgentProfile>();
  const resolvedCache = new Map<string, ResolvedAgentProfile>();

  for (const profile of raw) {
    if (profileMap.has(profile.name)) {
      throw new Error(`Duplicate agent profile name: "${profile.name}"`);
    }
    profileMap.set(profile.name, profile);
  }

  for (const profile of raw) {
    const merged = resolveMergedProfile(profile.name, profileMap, mergedCache, []);
    resolvedCache.set(profile.name, toResolvedProfile(merged));
  }

  applySubagentDescriptions(mergedCache, resolvedCache);
  linkResolvedSubagents(mergedCache, resolvedCache);

  const result: Record<string, ResolvedAgentProfile> = {};
  for (const [name, profile] of resolvedCache) {
    result[name] = profile;
  }

  return result;
}

function resolveMergedProfile(
  name: string,
  profileMap: Map<string, RawAgentProfile>,
  cache: Map<string, MergedAgentProfile>,
  stack: string[],
): MergedAgentProfile {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  const cycleIndex = stack.indexOf(name);
  if (cycleIndex !== -1) {
    const cycle = [...stack.slice(cycleIndex), name].join(' -> ');
    throw new Error(`Agent profile extends cycle detected: ${cycle}`);
  }

  const profile = profileMap.get(name);
  if (profile === undefined) {
    throw new Error(`Agent profile "${name}" not found`);
  }

  let parent: MergedAgentProfile | undefined;
  if (profile.extends !== undefined) {
    if (!profileMap.has(profile.extends)) {
      throw new Error(
        `Agent profile "${profile.name}" extends "${profile.extends}" but parent profile was not found`,
      );
    }
    parent = resolveMergedProfile(profile.extends, profileMap, cache, [...stack, name]);
  }

  const merged: MergedAgentProfile = {
    name: profile.name,
    description: profile.description,
    systemPromptTemplate: profile.systemPromptTemplate ?? parent?.systemPromptTemplate ?? '',
    promptVars: {
      ...parent?.promptVars,
      ...profile.promptVars,
    },
    tools: profile.tools !== undefined ? [...profile.tools] : [...(parent?.tools ?? [])],
    whenToUse: profile.whenToUse ?? parent?.whenToUse,
    subagents: cloneSubagents(profile.subagents),
  };

  cache.set(profile.name, merged);
  return merged;
}

function toResolvedProfile(merged: MergedAgentProfile): ResolvedAgentProfile {
  return {
    name: merged.name,
    description: merged.description,
    systemPrompt: createSystemPromptRenderer(merged),
    tools: [...merged.tools],
    whenToUse: merged.whenToUse,
  };
}

/**
 * Build a renderer that captures the merged template and prompt vars.
 * The runtime SystemPromptContext is mapped to the template variables
 * (KIMI_OS, KIMI_AGENTS_MD, ...) at render time.
 */
function createSystemPromptRenderer(merged: MergedAgentProfile): SystemPromptRenderer {
  return (context: SystemPromptContext): string => {
    const vars = buildTemplateVars(context, merged.promptVars);
    try {
      return renderPrompt(merged.systemPromptTemplate, vars);
    } catch (error) {
      throw new Error(
        `Failed to render system prompt for agent profile "${merged.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  };
}

function buildTemplateVars(
  context: SystemPromptContext,
  promptVars: Record<string, string>,
): Record<string, string> {
  const skills =
    typeof context.skills === 'string'
      ? context.skills
      : (context.skills?.getModelSkillListing() ?? '');
  const now =
    context.now instanceof Date
      ? context.now.toISOString()
      : (context.now ?? new Date().toISOString());

  return {
    ...promptVars,
    KIMI_OS: context.osEnv.osKind,
    KIMI_SHELL: `${context.osEnv.shellName} (\`${context.osEnv.shellPath}\`)`,
    KIMI_NOW: now,
    KIMI_WORK_DIR: context.cwd,
    KIMI_WORK_DIR_LS: context.cwdListing ?? '',
    KIMI_AGENTS_MD: context.agentsMd ?? '',
    KIMI_MEMORY: context.memoryIndex ?? '',
    KIMI_SKILLS: skills,
    KIMI_ADDITIONAL_DIRS_INFO: context.additionalDirsInfo ?? '',
    ROLE_ADDITIONAL:
      context.roleAdditional ?? promptVars['ROLE_ADDITIONAL'] ?? promptVars['roleAdditional'] ?? '',
  };
}

function applySubagentDescriptions(
  mergedProfiles: Map<string, MergedAgentProfile>,
  resolvedProfiles: Map<string, ResolvedAgentProfile>,
): void {
  for (const [ownerName, owner] of mergedProfiles) {
    if (owner.subagents === undefined) continue;
    for (const [subagentName, subagent] of Object.entries(owner.subagents)) {
      const target = resolvedProfiles.get(subagentName);
      if (target === undefined) {
        throwMissingSubagent(ownerName, subagentName);
      }
      if (target.description === undefined && subagent.description !== undefined) {
        target.description = subagent.description;
      }
    }
  }
}

function linkResolvedSubagents(
  mergedProfiles: Map<string, MergedAgentProfile>,
  resolvedProfiles: Map<string, ResolvedAgentProfile>,
): void {
  for (const [ownerName, owner] of mergedProfiles) {
    if (owner.subagents === undefined) continue;

    const subagents: Record<string, ResolvedAgentProfile> = {};
    for (const subagentName of Object.keys(owner.subagents)) {
      const target = resolvedProfiles.get(subagentName);
      if (target === undefined) {
        throwMissingSubagent(ownerName, subagentName);
      }
      subagents[subagentName] = target;
    }

    const resolved = resolvedProfiles.get(ownerName);
    if (resolved !== undefined) {
      resolved.subagents = subagents;
    }
  }
}

function throwMissingSubagent(ownerName: string, subagentName: string): never {
  throw new Error(
    `Agent profile "${ownerName}" declares subagent "${subagentName}" but that agent profile was not found`,
  );
}

function cloneSubagents(
  subagents: Record<string, RawSubagentProfile> | undefined,
): Record<string, RawSubagentProfile> | undefined {
  if (subagents === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(subagents).map(([name, subagent]) => [name, { ...subagent }]),
  );
}
