import { BUILTIN_PROFILE_SOURCE_ID } from './catalog';
import { DEFAULT_AGENT_PROFILE_NAME, type AgentProfile } from '../definition/types';

export const DEFAULT_SUBAGENT_PROFILE_NAME = 'coder';

export function subagentAllowlistFor(
  catalog: {
    getDefault(): Pick<AgentProfile, 'subagents'>;
  },
  caller: {
    readonly profileName?: string;
    readonly subagents?: readonly string[];
  },
  extras?: readonly string[],
): readonly string[] | undefined {
  const declared = caller.subagents ?? catalog.getDefault().subagents;
  if (declared?.length === 1 && declared[0] === '*') return undefined;
  if (extras === undefined || extras.length === 0) return declared;
  return [...new Set([...(declared ?? []), ...extras])];
}

export function isDiscoveredAgentProfileSource(sourceId: string | undefined): boolean {
  return (
    sourceId !== undefined &&
    sourceId !== BUILTIN_PROFILE_SOURCE_ID &&
    !sourceId.startsWith('feature:')
  );
}

export function rootDelegationExtras(
  catalog: {
    inspect(name: string): { readonly sourceId: string } | undefined;
  },
  caller: {
    readonly profileName?: string;
    readonly subagents?: readonly string[];
  },
  profiles: readonly { readonly name: string }[],
): readonly string[] | undefined {
  if (
    caller.profileName !== undefined &&
    caller.profileName !== DEFAULT_AGENT_PROFILE_NAME &&
    caller.subagents !== undefined
  ) {
    return undefined;
  }
  const discovered = profiles
    .filter(
      (profile) =>
        profile.name !== DEFAULT_AGENT_PROFILE_NAME &&
        isDiscoveredAgentProfileSource(catalog.inspect(profile.name)?.sourceId),
    )
    .map((profile) => profile.name);
  return discovered.length === 0 ? undefined : discovered;
}

export function profileCanDelegate(
  profile: Pick<AgentProfile, 'tools' | 'disallowedTools'>,
): boolean {
  const possesses = (name: string): boolean =>
    (profile.tools === undefined || profile.tools.includes(name)) &&
    !(profile.disallowedTools ?? []).includes(name);
  return possesses('Agent') || possesses('AgentSwarm');
}

export function withoutDelegatingTargets(
  catalog: {
    get(name: string): Pick<AgentProfile, 'tools' | 'disallowedTools'> | undefined;
  },
  allowlist: readonly string[],
): readonly string[] {
  return allowlist.filter((name) => {
    const target = catalog.get(name);
    return target === undefined || !profileCanDelegate(target);
  });
}

export function subagentTypeNotAllowedMessage(
  name: string,
  allowlist: readonly string[],
): string {
  const allowed = allowlist.length === 0 ? 'none' : allowlist.join(', ');
  return `Subagent type "${name}" is not allowed for this agent. Allowed subagent types: ${allowed}.`;
}
