/**
 * `SYSTEM.md` global main-agent prompt override.
 *
 * `<brandHome>/SYSTEM.md` (default `~/.kimi-code/SYSTEM.md`, moves with
 * `KIMI_CODE_HOME`) permanently replaces the builtin default profile's system
 * prompt while the file exists and is non-empty. Only the prompt is replaced
 * — every other profile capability comes from the builtin default — and
 * explicit intent still wins: higher-priority sources (project `agent.md`,
 * `--agent-file`) override it, and binding a different profile ignores it.
 * The body is a prompt template rendered against the agent-file variable
 * table: `${var}` placeholders substitute live context, and `${base_prompt}`
 * embeds the builtin default prompt. A missing or empty file yields no
 * definition; a read failure degrades to `warn` instead of rejecting,
 * matching the directory-source policy that a transient fs error must never
 * poison a session.
 *
 * Ported from the v2 engine (`packages/agent-core-v2/src/app/agentFileCatalog/systemFile.ts`)
 * — keep the two in sync: SYSTEM.md semantics must land in both engines.
 */

import { promises as fs } from 'node:fs';
import { join } from 'pathe';

import type { ResolvedAgentProfile } from '../types';

import { renderAgentFileTemplate } from './from-file';
import { isFilePath } from './paths';
import type { AgentFileDefinition } from './types';

export const SYSTEM_MD_FILENAME = 'SYSTEM.md';

/**
 * Loads `<brandHome>/SYSTEM.md` as a synthetic agent-file definition for the
 * default profile, or `undefined` when the file is absent or empty.
 */
export async function loadSystemMdDefinition(
  brandHome: string,
  warn: (message: string) => void,
): Promise<AgentFileDefinition | undefined> {
  const path = join(brandHome, SYSTEM_MD_FILENAME);
  let text: string;
  try {
    if (!(await isFilePath(path))) return undefined;
    text = await fs.readFile(path, 'utf-8');
  } catch (error) {
    warn(`agent SYSTEM.md load failed: ${String(error)} [${path}]`);
    return undefined;
  }
  if (text.trim().length === 0) return undefined;
  return {
    name: 'agent',
    description: '',
    override: true,
    prompt: text.trim(),
    path,
    source: 'user',
  };
}

/**
 * Builds the SYSTEM.md profile variant: the builtin default with its system
 * prompt replaced by the file body. Every other capability comes from the
 * builtin default.
 */
export function systemMdProfile(
  definition: AgentFileDefinition,
  builtinDefault: ResolvedAgentProfile,
): ResolvedAgentProfile {
  const skillActive = builtinDefault.tools.includes('Skill');
  return {
    name: builtinDefault.name,
    description: builtinDefault.description,
    systemPrompt: (context) =>
      renderAgentFileTemplate(definition.prompt, context, { skillActive }, (ctx) =>
        builtinDefault.systemPrompt(ctx),
      ),
    tools: [...builtinDefault.tools],
    disallowedTools:
      builtinDefault.disallowedTools === undefined
        ? undefined
        : [...builtinDefault.disallowedTools],
    whenToUse: builtinDefault.whenToUse,
    subagents:
      builtinDefault.subagents === undefined ? undefined : { ...builtinDefault.subagents },
    modelPreference: builtinDefault.modelPreference,
  };
}
