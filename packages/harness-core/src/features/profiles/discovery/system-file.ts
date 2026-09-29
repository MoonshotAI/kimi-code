import { join } from 'pathe';

import { HostFsError, type OsFsPort } from '#/features/os/host/index';

import { isFilePath } from './paths';
import { renderPromptTemplateResult } from '../render/render';
import { skillActiveFor } from '../shared';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
  type AgentProfile,
} from '../definition/types';

export const SYSTEM_MD_FILENAME = 'SYSTEM.md';

export async function loadSystemMdProfile(
  fs: OsFsPort,
  brandHome: string,
  builtinDefault: AgentProfile,
  warn?: (message: string) => void,
): Promise<AgentProfile | undefined> {
  const path = join(brandHome, SYSTEM_MD_FILENAME);
  let text: string;
  try {
    if (!(await isFilePath(fs, path))) return undefined;
    text = await fs.readText(path);
  } catch (error) {
    if (error instanceof HostFsError && error.code === 'os.fs.unavailable') {
      throw error;
    }
    warn?.(`agent SYSTEM.md load failed: ${String(error)} [${path}]`);
    return undefined;
  }
  if (text.trim().length === 0) return undefined;
  const skillActive =
    (builtinDefault.tools === undefined || skillActiveFor(builtinDefault.tools)) &&
    !(builtinDefault.disallowedTools ?? []).includes('Skill');
  return normalizeAgentProfile({
    name: DEFAULT_AGENT_PROFILE_NAME,
    description: builtinDefault.description,
    override: true,
    tools: builtinDefault.tools,
    disallowedTools: builtinDefault.disallowedTools,
    subagents: builtinDefault.subagents,
    renderSystemPrompt: (context) =>
      renderPromptTemplateResult(text, context, { skillActive }, (ctx) =>
        builtinDefault.renderSystemPrompt(ctx),
      ),
  });
}
