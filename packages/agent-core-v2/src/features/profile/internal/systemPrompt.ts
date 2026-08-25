import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { TOOLS_SECTION, type ToolsConfig } from '#/agent/toolPolicy/configSection';
import { isToolActiveComposed } from '#/agent/toolPolicy/evaluate';
import { IConfigService } from '#/app/config/config';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import type { IPluginService } from '#/app/plugin/plugin';
import type {
  ApplyProfileOptions,
  ResolvedAgentProfile,
  SystemPromptContext,
} from '#/features/profile/profile';
import {
  prepareSystemPromptContext,
  type LoadedAgentsMd,
} from '#/features/profile/profileContext';
import type { IHostClock } from '#/os/interface/hostClock';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import type { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import type { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import type { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import type { ToolSource } from '#/tool/toolContract';

export const PLUGIN_SECTIONS_MAX_BYTES = 64 * 1024;

export interface SystemPromptContextDeps {
  readonly runtime: IAgentRuntimeService;
  readonly sessionContext: ISessionContext;
  readonly workspace: ISessionWorkspaceContext;
  readonly instructions: ISessionInstructionsProvider;
  readonly bootstrap: IBootstrapService;
  readonly skillCatalog: ISessionSkillCatalog;
  readonly plugins: IPluginService;
  readonly clock: IHostClock;
  readonly identity: IAgentIdentity;
  readonly toolPolicyGate: ISessionToolPolicyGate;
  readonly sessionToolPolicy: ISessionToolPolicy;
  readonly config: IConfigService;
}

export interface SystemPromptCaches {
  frozenSkillListing: string | undefined;
  frozenPluginSections: string | undefined;
  readonly emittedPluginBudgetWarnings: Set<string>;
}

export async function buildSystemPromptContext(
  deps: SystemPromptContextDeps,
  caches: SystemPromptCaches,
  profile: ResolvedAgentProfile,
  options: ApplyProfileOptions | undefined,
  warn: (message: string, code: string) => void,
): Promise<SystemPromptContext> {
  const preloadedAgentsMd = await workspaceInstructionsSnapshot(deps);
  const fsAvailable = deps.runtime.isAvailable(['fs']);
  const lease = deps.runtime.acquire(fsAvailable ? ['fs'] : []);
  const env = lease.runtime.environment;
  const view = new RuntimeWorkspaceView(lease.runtime, {
    workDir: deps.sessionContext.cwd,
    additionalDirs: options?.additionalDirs ?? deps.workspace.additionalDirs,
  });
  let base: SystemPromptContext;
  try {
    base = !fsAvailable
      ? {}
      : await prepareSystemPromptContext(
          { fs: lease.runtime.fs!, homeDir: env.homeDir },
          view.workDir,
          deps.bootstrap.homeDir,
          {
            additionalDirs: view.additionalDirs,
            preloadedAgentsMd,
          },
        );
  } finally {
    lease.dispose();
  }
  const skills = await resolveSkillListing(deps, caches);
  const pluginSections = await resolvePluginSections(deps, caches, warn);
  const now = deps.clock.now();
  const timeZone = deps.clock.timeZone();
  return {
    ...base,
    cwd: view.workDir,
    osKind: env.osKind,
    shellName: env.shellName,
    shellPath: env.shellPath,
    now: now.toISOString(),
    timeZone,
    skills,
    pluginSections,
    skillActive: isToolActiveForProfile(deps, profile, 'Skill'),
    productName: (await deps.identity.resolved()).displayName,
    replyStyleGuide: deps.bootstrap.args.replyStyleGuide,
  };
}

async function workspaceInstructionsSnapshot(
  deps: SystemPromptContextDeps,
): Promise<LoadedAgentsMd> {
  await deps.instructions.ready;
  return {
    content: deps.instructions.agentsMd ?? '',
    warning: deps.instructions.agentsMdWarning,
    paths: deps.instructions.agentsMdPaths ?? [],
  };
}

function isToolActiveForProfile(
  deps: SystemPromptContextDeps,
  profile: ResolvedAgentProfile,
  name: string,
  source: ToolSource = 'builtin',
): boolean {
  return isToolActiveComposed(
    {
      workspaceDisabledTools: deps.toolPolicyGate.disabledTools,
      profile,
      global: deps.config.get<ToolsConfig>(TOOLS_SECTION),
      sessionDisabledTools: deps.sessionToolPolicy.disabledTools(),
    },
    name,
    source,
  );
}

async function resolveSkillListing(
  deps: SystemPromptContextDeps,
  caches: SystemPromptCaches,
): Promise<string> {
  if (caches.frozenSkillListing !== undefined) return caches.frozenSkillListing;
  try {
    await deps.skillCatalog.ready;
    const listing = deps.skillCatalog.catalog.getModelSkillListing();
    caches.frozenSkillListing = listing;
    return listing;
  } catch {
    return '';
  }
}

async function resolvePluginSections(
  deps: SystemPromptContextDeps,
  caches: SystemPromptCaches,
  warn: (message: string, code: string) => void,
): Promise<string> {
  if (caches.frozenPluginSections !== undefined) return caches.frozenPluginSections;
  const sections = await deps.plugins.enabledSystemPrompts();
  const parts: string[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  for (const section of sections) {
    const block = `<!-- From: plugin ${section.pluginId} -->\n${section.content}`;
    const bytes = Buffer.byteLength(block, 'utf8');
    if (totalBytes + bytes > PLUGIN_SECTIONS_MAX_BYTES) {
      skipped.push(section.pluginId);
      continue;
    }
    totalBytes += bytes;
    parts.push(block);
  }
  if (skipped.length > 0) {
    const newlySkipped = skipped.filter((id) => !caches.emittedPluginBudgetWarnings.has(id));
    if (newlySkipped.length > 0) {
      for (const id of newlySkipped) caches.emittedPluginBudgetWarnings.add(id);
      warn(
        `Plugin system-prompt contributions from ${newlySkipped.map((id) => `"${id}"`).join(', ')} ` +
          `were skipped: the aggregate ${PLUGIN_SECTIONS_MAX_BYTES / 1024} KB budget is exhausted.`,
        'plugin-sections-oversized',
      );
    }
  }
  const resolved = parts.join('\n\n');
  if (deps.plugins.hasLoadedSnapshot()) caches.frozenPluginSections = resolved;
  return resolved;
}
