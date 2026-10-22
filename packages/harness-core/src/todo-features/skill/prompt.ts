import type { SkillSource } from './catalog/types';
import { escapeXml } from './catalog/xml-escape';

export const SKILLS_SECTION_PROSE =
  'Skills are reusable, composable capabilities that enhance your abilities. Each skill is either a self-contained directory with a `SKILL.md` file or a standalone `.md` file that contains instructions, examples, and/or reference material.\n\n' +
  'Identify the skills relevant to your current task and read the skill file for its instructions; only read further skill details when needed, to conserve the context window.\n\n' +
  '## Available skills\n\n' +
  'Skills are grouped by scope (`Project`, `User`, `Extra`, `Built-in`) so you can tell where each came from. When the user refers to "the skill in this project" or "the user-scope skill", use the scope heading to disambiguate. When multiple scopes define a skill with the same name, the more specific scope takes precedence: **Project overrides User overrides Extra overrides Built-in**.';

export function renderSkillsSection(listing: string): string {
  return `\n\n# Skills\n\n${SKILLS_SECTION_PROSE}\n\n${listing}\n\n`;
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
