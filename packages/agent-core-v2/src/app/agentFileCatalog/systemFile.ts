/**
 * `agentFileCatalog` domain (L3) — `SYSTEM.md` global main-agent prompt override.
 *
 * `<brandHome>/SYSTEM.md` (default `~/.kimi-code/SYSTEM.md`, moves with
 * `KIMI_CODE_HOME`) permanently replaces the builtin default profile's system
 * prompt while the file exists and is non-empty. Only the prompt is replaced —
 * tools and description are copied from the builtin default — and explicit
 * intent still wins: higher-priority sources (project `agent.md`,
 * `--agent-file`) override it, and binding a different profile ignores it.
 * Unlike plain agent files the body is a template: `${var}` placeholders are
 * substituted from the live `AgentProfileContext` at render time; unknown
 * placeholders stay verbatim. Pure logic; no scoped state.
 */

import { join } from 'pathe';

import {
  DEFAULT_AGENT_PROFILE_NAME,
  type AgentProfile,
  type AgentProfileContext,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { skillActiveFor } from '#/app/agentProfileCatalog/profile-shared';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';

import { isFilePath } from './paths';

export const SYSTEM_MD_FILENAME = 'SYSTEM.md';

/**
 * Synthesize the prompt-override profile from `<brandHome>/SYSTEM.md`. Returns
 * `undefined` when the file is missing or empty after trimming; a read failure
 * degrades to `warn` instead of rejecting, matching the directory-source
 * policy that a transient fs error must never poison a session.
 */
export async function loadSystemMdProfile(
  fs: IHostFileSystem,
  brandHome: string,
  builtinDefault: AgentProfile,
  warn: (message: string) => void,
): Promise<AgentProfile | undefined> {
  const path = join(brandHome, SYSTEM_MD_FILENAME);
  let text: string;
  try {
    if (!(await isFilePath(fs, path))) return undefined;
    text = await fs.readText(path);
  } catch (error) {
    if (
      error instanceof HostFsError &&
      error.code === OsFsErrors.codes.OS_FS_UNAVAILABLE
    ) {
      throw error;
    }
    warn(`agent SYSTEM.md load failed: ${String(error)} [${path}]`);
    return undefined;
  }
  if (text.trim().length === 0) return undefined;
  const skillActive =
    (builtinDefault.tools === undefined || skillActiveFor(builtinDefault.tools)) &&
    !(builtinDefault.disallowedTools ?? []).includes('Skill');
  return {
    name: DEFAULT_AGENT_PROFILE_NAME,
    description: builtinDefault.description,
    override: true,
    tools: builtinDefault.tools,
    disallowedTools: builtinDefault.disallowedTools,
    systemPrompt: (context) => renderSystemMdPrompt(text, context, { skillActive }),
  };
}

const SYSTEM_MD_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Substitute `${var}` placeholders from the live prompt context. Only the
 * known variables are replaced; unknown `${...}` stays verbatim and a bare `$`
 * is never special. Missing context fields render as empty strings, matching
 * the builtin template; `${skills}` is empty when the profile disables the
 * Skill tool.
 */
export function renderSystemMdPrompt(
  template: string,
  context: AgentProfileContext,
  options: { readonly skillActive: boolean },
): string {
  const shellName = context.shellName ?? '';
  const shellPath = context.shellPath ?? '';
  const skillActive = context.skillActive ?? options.skillActive;
  const vars: Readonly<Record<string, string>> = {
    skills: skillActive ? (context.skills ?? '') : '',
    agents_md: context.agentsMd ?? '',
    cwd: context.cwd ?? '',
    cwd_listing: context.cwdListing ?? '',
    os: context.osKind ?? '',
    shell: shellName.length > 0 ? `${shellName} (\`${shellPath}\`)` : '',
    now: context.now ?? new Date().toISOString(),
  };
  return template.replace(SYSTEM_MD_VARIABLE, (match: string, name: string) => vars[name] ?? match);
}
