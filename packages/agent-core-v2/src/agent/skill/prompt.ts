import { escapeXml } from '#/_base/utils/xml-escape';
import type { SkillSource } from '#/app/skillCatalog/types';

export type SkillPromptTrigger = 'user-slash' | 'model-tool' | 'nested-skill';

export interface RenderSkillPromptInput {
  readonly skillName: string;
  readonly skillArgs: string;
  readonly skillContent: string;
  readonly skillSource?: SkillSource | undefined;
  readonly skillDir?: string | undefined;
  /**
   * Sorted paths of the skill's bundled resource files, listed inside the
   * loaded block so the model can fetch one through the Skill tool's
   * `resource` parameter.
   */
  readonly skillResources?: readonly string[] | undefined;
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
  const lines = [`<kimi-skill-loaded${renderSkillAttributes(input)}>`, input.skillContent];
  const skillResources = input.skillResources;
  if (skillResources !== undefined && skillResources.length > 0) {
    lines.push(
      '<bundled-resources>',
      `This skill ships bundled resource files. Load one with the Skill tool: Skill(skill="${escapeXml(input.skillName)}", resource="<path>").`,
      ...skillResources.map((path) => `- ${path}`),
      '</bundled-resources>',
    );
  }
  lines.push('</kimi-skill-loaded>');
  return lines.join('\n');
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
