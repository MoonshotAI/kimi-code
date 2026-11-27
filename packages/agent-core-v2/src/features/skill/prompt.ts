import { escapeXml } from '#/_base/utils/xml-escape';
import {
  promptMetadataTextFromContentParts,
  promptMetadataTextFromText,
} from '#/agent/prompt/promptMetadataText';
import type { SkillSource } from '#/features/skill/catalog/types';

import type { PromptWithSkillsInput, SkillActivationInput } from './skill';

export function skillCommandLabel(skillName: string, skillArgs?: string): string {
  const args = skillArgs?.trim();
  return args === undefined || args.length === 0 ? `/${skillName}` : `/${skillName} ${args}`;
}

export function promptMetadataTextFromSkill(input: SkillActivationInput): string | undefined {
  return (
    promptMetadataTextFromContentParts([], input.clientMetadata) ??
    promptMetadataTextFromText(skillCommandLabel(input.name, input.args))
  );
}

export function promptMetadataTextFromBundledSkills(
  input: PromptWithSkillsInput,
): string | undefined {
  return (
    promptMetadataTextFromContentParts(input.input, input.clientMetadata) ??
    promptMetadataTextFromText(
      input.skills.map((skill) => skillCommandLabel(skill.name, skill.args)).join(' '),
    )
  );
}

export type SkillPromptTrigger = 'user-slash' | 'model-tool' | 'nested-skill';

export interface RenderSkillPromptInput {
  readonly skillName: string;
  readonly skillArgs: string;
  readonly skillContent: string;
  readonly skillSource?: SkillSource | undefined;
  readonly skillDir?: string | undefined;
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
    ['dir', input.skillDir],
    ['args', input.skillArgs],
  ];

  return attrs
    .filter((item): item is readonly [string, string] => item[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join('');
}
