import { NOTIFY_USER_GUIDANCE } from '#/features/notify/index';

import type {
  AgentProfile,
  AgentProfileContext,
  EnvironmentDisclosureSnapshot,
  SystemPromptRenderResult,
} from '../definition/types';
import { renderPrompt } from './render-prompt';
import SYSTEM_PROMPT_TEMPLATE from './system.md?raw';
import { systemPromptVars } from './vars';

export function renderAgentProfilePrompt(
  profile: AgentProfile,
  context: AgentProfileContext,
): SystemPromptRenderResult {
  const rendered = profile.renderSystemPrompt(context);
  if (context.notifyUserActive !== true || rendered.text.includes(NOTIFY_USER_GUIDANCE)) return rendered;
  return { ...rendered, text: `${rendered.text}\n\n${NOTIFY_USER_GUIDANCE}` };
}

export function renderPromptTemplateResult(
  template: string,
  context: AgentProfileContext,
  options: { readonly skillActive: boolean },
  basePrompt?: (context: AgentProfileContext) => SystemPromptRenderResult,
): SystemPromptRenderResult {
  const vars = systemPromptVars(context, options);
  let baseResult: SystemPromptRenderResult | undefined;
  if (basePrompt !== undefined && template.includes('${base_prompt}')) {
    baseResult = basePrompt(context);
    vars['base_prompt'] = baseResult.text;
  }
  return {
    text: renderPrompt(template, vars),
    environment: mergeEnvironmentDisclosure(environmentForTemplate(context), baseResult?.environment),
  };
}

export function renderSystemPromptResult(
  roleAdditional: string,
  context: AgentProfileContext,
  options: { readonly skillActive: boolean },
): SystemPromptRenderResult {
  return {
    text: renderPrompt(SYSTEM_PROMPT_TEMPLATE, {
      ...systemPromptVars(context, options),
      role_additional: roleAdditional,
    }),
    environment: environmentForTemplate(context),
  };
}

function environmentForTemplate(context: AgentProfileContext): EnvironmentDisclosureSnapshot {
  return { cwd: context.cwd ?? '' };
}

function mergeEnvironmentDisclosure(
  direct: EnvironmentDisclosureSnapshot,
  base: EnvironmentDisclosureSnapshot | undefined,
): EnvironmentDisclosureSnapshot {
  if (base === undefined) return direct;
  return { cwd: direct.cwd || base.cwd };
}
