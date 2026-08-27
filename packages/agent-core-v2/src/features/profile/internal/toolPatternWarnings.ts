import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import { TOOLS_SECTION, type ToolsConfig } from '#/agent/toolPolicy/configSection';
import {
  findInactiveToolPatterns,
  literalToolNames,
  type InactiveToolPattern,
} from '#/agent/toolPolicy/evaluate';
import type { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import type { IConfigService } from '#/app/config/config';
import type { ResolvedAgentProfile } from '#/features/profile/profile';

export interface ToolPatternWarningDeps {
  readonly config: IConfigService;
  readonly toolReferences: readonly { readonly name: string }[];
  readonly builtinProfiles: IBuiltinAgentProfileLoader;
}

export function publishToolPatternWarnings(
  deps: ToolPatternWarningDeps,
  emitted: Set<string>,
  profile: ResolvedAgentProfile | undefined,
  warn: (message: string, code: string) => void,
): void {
  const known = new Set<string>();
  for (const contribution of getAgentToolContributions()) known.add(contribution.options.name);
  for (const ref of deps.toolReferences) known.add(ref.name);
  for (const builtin of deps.builtinProfiles.list()) {
    for (const name of literalToolNames([
      ...(builtin.tools ?? []),
      ...(builtin.disallowedTools ?? []),
    ])) {
      known.add(name);
    }
  }
  const checks: {
    context: string;
    field: string;
    patterns: readonly string[] | undefined;
  }[] = [];
  if (profile !== undefined) {
    checks.push(
      { context: `profile "${profile.name}"`, field: 'tools', patterns: profile.tools },
      {
        context: `profile "${profile.name}"`,
        field: 'disallowedTools',
        patterns: profile.disallowedTools,
      },
    );
  }
  const global = deps.config.get<ToolsConfig>(TOOLS_SECTION);
  checks.push(
    { context: 'the global [tools] config', field: 'enabled', patterns: global?.enabled },
    { context: 'the global [tools] config', field: 'disabled', patterns: global?.disabled },
  );
  for (const { context, field, patterns } of checks) {
    if (patterns === undefined) continue;
    for (const issue of findInactiveToolPatterns(patterns, (name) => known.has(name))) {
      const key = `${context}|${field}|${issue.pattern}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      warn(describeInactiveToolPattern(context, field, issue), 'tool-pattern-no-match');
    }
  }
}

function describeInactiveToolPattern(
  context: string,
  field: string,
  issue: InactiveToolPattern,
): string {
  switch (issue.kind) {
    case 'unknown-tool':
      return `Tool pattern "${issue.pattern}" in ${context} ${field} does not match any registered or built-in tool; it will never activate anything.`;
    case 'wildcard-not-mcp':
      return `Tool pattern "${issue.pattern}" in ${context} ${field} uses wildcards, which only match MCP tools (names starting with "mcp__"); it will never activate anything.`;
    case 'incomplete-mcp-name':
      return `Tool pattern "${issue.pattern}" in ${context} ${field} matches no tool; use "${issue.pattern}__*" to match the whole MCP server.`;
  }
}
