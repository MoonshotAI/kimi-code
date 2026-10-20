import type { OsProcessPort } from '#/features/os/index';

export const DEFAULT_AGENT_PROFILE_NAME = 'agent';

export const DEFAULT_SUBAGENT_PROFILE_NAME = 'coder';

export const BUILTIN_PROFILE_SOURCE_ID = 'builtin';

export const PRIORITY = {
  builtin: 0,
  plugin: 5,
  user: 10,
  extra: 20,
  workspace: 30,
  explicit: 40,
} as const;

export interface AgentProfilePromptPrefixContext {
  readonly cwd: string;
  readonly process?: OsProcessPort;
  readonly log?: (message: string) => void;
}

export interface AgentProfileContext {
  readonly cwd?: string;
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly additionalDirsInfo?: string;
  readonly osKind?: string;
  readonly shellName?: string;
  readonly shellPath?: string;
  readonly skills?: string;
  readonly skillActive?: boolean;
  readonly pluginSections?: string;
  readonly productName?: string;
  readonly replyStyleGuide?: string;
  readonly notifyUserActive?: boolean;
  readonly [key: string]: unknown;
}

export interface EnvironmentDisclosureSnapshot {
  readonly cwd: string;
}

export interface SystemPromptRenderResult {
  readonly text: string;
  readonly environment: EnvironmentDisclosureSnapshot;
}

export interface AgentProfile {
  readonly name: string;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly override?: boolean;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly systemPrompt: (context: AgentProfileContext) => string;
  readonly renderSystemPrompt: (context: AgentProfileContext) => SystemPromptRenderResult;
  readonly promptPrefix?: (ctx: AgentProfilePromptPrefixContext) => Promise<string>;
}

export type AgentProfileInput = Omit<AgentProfile, 'systemPrompt' | 'renderSystemPrompt'> &
  (
    | {
        readonly systemPrompt: (context: AgentProfileContext) => string;
        readonly renderSystemPrompt?: (
          context: AgentProfileContext,
        ) => SystemPromptRenderResult;
      }
    | {
        readonly systemPrompt?: (context: AgentProfileContext) => string;
        readonly renderSystemPrompt: (context: AgentProfileContext) => SystemPromptRenderResult;
      }
  );

export function normalizeAgentProfile(input: AgentProfileInput): AgentProfile {
  if (input.renderSystemPrompt !== undefined) {
    const render = input.renderSystemPrompt.bind(input);
    return {
      ...input,
      renderSystemPrompt: render,
      systemPrompt: (context) => render(context).text,
    };
  }
  if (input.systemPrompt !== undefined) {
    const systemPrompt = input.systemPrompt.bind(input);
    return {
      ...input,
      systemPrompt,
      renderSystemPrompt: (context) => ({
        text: systemPrompt(context),
        environment: { cwd: context.cwd ?? '' },
      }),
    };
  }
  throw new Error(
    `Agent profile "${input.name}" must define systemPrompt or renderSystemPrompt.`,
  );
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

export async function applyProfilePromptPrefix(
  profile: AgentProfile,
  prompt: string,
  ctx: AgentProfilePromptPrefixContext,
): Promise<string> {
  if (profile.promptPrefix === undefined) return prompt;
  try {
    const prefix = await profile.promptPrefix(ctx);
    return prefix.length > 0 ? `${prefix}\n\n${prompt}` : prompt;
  } catch {
    return prompt;
  }
}
