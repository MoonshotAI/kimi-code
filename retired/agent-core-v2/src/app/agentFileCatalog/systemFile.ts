/**
 * `agentFileCatalog` domain (L3) — `SYSTEM.md` global main-agent prompt override.
 *
 * `<brandHome>/SYSTEM.md` (default `~/.kimi-code/SYSTEM.md`, moves with
 * `KIMI_CODE_HOME`) permanently replaces the builtin default profile's system
 * prompt while the file exists and is non-empty. Only the prompt is replaced —
 * tools and description are copied from the builtin default — and explicit
 * intent still wins: higher-priority sources (project `agent.md`,
 * `--agent-file`) override it, and binding a different profile ignores it.
 * The body is a prompt template rendered against the shared variable table
 * (`systemPromptVars`): `${var}` placeholders substitute live context, and
 * `${base_prompt}` embeds the builtin default prompt. A missing or empty file
 * yields no profile; a read failure degrades to `warn` instead of rejecting,
 * matching the directory-source policy that a transient fs error must never
 * poison a session. Pure logic; no scoped state.
 */

import { join } from 'pathe';

import {
  DEFAULT_AGENT_PROFILE_NAME,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  renderPromptTemplate,
  skillActiveFor,
} from '#/app/agentProfileCatalog/profile-shared';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';

import { isFilePath } from './paths';

export const SYSTEM_MD_FILENAME = 'SYSTEM.md';

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
    subagents: builtinDefault.subagents,
    systemPrompt: (context) =>
      renderPromptTemplate(text, context, { skillActive }, (ctx) =>
        builtinDefault.systemPrompt(ctx),
      ),
  };
}
