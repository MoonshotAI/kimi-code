import { escapeXml } from '#/_base/utils/xml-escape';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import { LOCAL_ENVIRONMENT_ID, type EnvironmentTarget } from '#/environment/environment';
import type { SkillDefinition, SkillSource } from '#/features/skill/catalog/types';

import type { SkillActivationInput } from './skill';

export function promptMetadataTextFromSkill(input: SkillActivationInput): string | undefined {
  const args = input.args?.trim();
  return promptMetadataTextFromContentParts(
    [{ type: 'text', text: args === undefined || args.length === 0 ? `/${input.name}` : `/${input.name} ${args}` }],
    input.clientMetadata,
  );
}

export type SkillPromptTrigger = 'user-slash' | 'model-tool' | 'nested-skill';

export interface RenderSkillPromptInput {
  readonly skillName: string;
  readonly skillArgs: string;
  readonly skillContent: string;
  readonly skillSource?: SkillSource | undefined;
  readonly skillEnvironment?: string;
  readonly skillDir?: string | undefined;
}

export function routedSkillEnvironment(
  skill: SkillDefinition,
  targets: readonly EnvironmentTarget[],
): string | undefined {
  const primary = targets.find((target) => target.primary)?.environmentId;
  if (targets.length < 2 || primary === undefined || skill.source === 'builtin') return undefined;
  const owner = skill.environmentId ?? (skill.source === 'project' ? primary : LOCAL_ENVIRONMENT_ID);
  return owner === primary ? undefined : owner;
}

interface RenderSkillLoadedBlockInput extends RenderSkillPromptInput {
  readonly trigger: SkillPromptTrigger;
}

export function renderUserSlashSkillPrompt(input: RenderSkillPromptInput): string {
  return [
    `User activated the skill "${escapeXml(input.skillName)}". Follow the loaded skill instructions.`,
    '',
    renderSkillLoadedBlock({ ...input, trigger: 'user-slash' }),
  ].join('\n');
}

export interface RenderModelToolSkillPromptInput extends RenderSkillPromptInput {
  readonly trigger: Extract<SkillPromptTrigger, 'model-tool' | 'nested-skill'>;
}

export function renderModelToolSkillPrompt(input: RenderModelToolSkillPromptInput): string {
  return [
    'Skill tool loaded instructions for this request. Follow them.',
    '',
    renderSkillLoadedBlock({ ...input, trigger: input.trigger }),
  ].join('\n');
}

export function renderSkillLoadedBlock(input: RenderSkillLoadedBlockInput): string {
  return [
    `<skill-loaded${renderSkillAttributes(input)}>`,
    input.skillContent,
    '</skill-loaded>',
  ].join('\n');
}

function renderSkillAttributes(input: RenderSkillLoadedBlockInput): string {
  const attrs: ReadonlyArray<readonly [string, string | undefined]> = [
    ['name', input.skillName],
    ['trigger', input.trigger],
    ['source', input.skillSource],
    ['environment', input.skillEnvironment],
    ['dir', input.skillDir],
    ['args', input.skillArgs],
  ];

  return attrs
    .filter((item): item is readonly [string, string] => item[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join('');
}
