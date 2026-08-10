import type {
  Session,
  SkillDiscoveryReport,
  SkillSummary,
} from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { formatErrorMessage } from '../utils/event-payload';

import type { SlashCommandHost } from './dispatch';
import type { KimiSlashCommand } from './types';

export type SkillListSession = Pick<Session, 'listSkills'>;

export interface SkillSlashCommands {
  readonly commands: readonly KimiSlashCommand[];
  readonly commandMap: ReadonlyMap<string, string>;
}

export function isUserActivatableSkill(skill: SkillSummary): boolean {
  return (
    skill.type === undefined ||
    skill.type === 'prompt' ||
    skill.type === 'inline' ||
    skill.type === 'flow'
  );
}

export function skillSlashCommandName(skill: SkillSummary): string | undefined {
  if (!isUserActivatableSkill(skill)) return undefined;
  return skill.source === 'builtin' || skill.isSubSkill === true
    ? skill.name
    : `skill:${skill.name}`;
}

function compareSkillSlashCommands(a: SkillSummary, b: SkillSummary): number {
  return (
    getSkillSlashCommandGroup(a.source) - getSkillSlashCommandGroup(b.source) ||
    a.name.localeCompare(b.name)
  );
}

function getSkillSlashCommandGroup(source: SkillSummary['source']): number {
  return source === 'builtin' ? 0 : 1;
}

export function buildSkillSlashCommands(skills: readonly SkillSummary[]): SkillSlashCommands {
  const commandMap = new Map<string, string>();
  const sortedSkills = [...skills].toSorted(compareSkillSlashCommands);
  const commands = sortedSkills.flatMap((skill) => {
    const commandName = skillSlashCommandName(skill);
    if (commandName === undefined) return [];
    commandMap.set(commandName, skill.name);
    return [{
      name: commandName,
      aliases: [],
      description: skill.description ?? '',
    }];
  });
  return { commands, commandMap };
}

export async function handleSkillsCommand(host: SlashCommandHost): Promise<void> {
  let report: SkillDiscoveryReport;
  try {
    report = host.session === undefined
      ? await host.harness.inspectWorkspaceSkills(host.state.appState.workDir)
      : await host.session.inspectSkills();
  } catch (error) {
    host.showError(`Failed to inspect skills: ${formatErrorMessage(error)}`);
    return;
  }

  const byName = new Map(report.skills.map((skill) => [skill.name, skill]));
  const diagnostics = report.diagnostics.map(
    (diagnostic) => `${diagnostic.path}: ${diagnostic.reason}`,
  );
  const notice = diagnostics.length === 0
    ? undefined
    : `${String(diagnostics.length)} discovery ${diagnostics.length === 1 ? 'issue' : 'issues'}:\n${diagnostics.join('\n')}`;

  host.mountEditorReplacement(
    new ChoicePickerComponent({
      title: `Skills (${String(report.skills.length)} loaded)`,
      hint: '↑↓ navigate · Enter insert slash command · Esc cancel',
      options: report.skills.map((skill) => {
        const commandName = skillSlashCommandName(skill);
        const type = skill.type ?? 'inline';
        return {
          value: skill.name,
          label: commandName === undefined
            ? `${skill.name} (not slash-invocable)`
            : `/${commandName} — ${skill.name}`,
          description: `[${skill.source} · ${type}] ${skill.description} · ${skill.path}`,
        };
      }),
      searchable: true,
      ...(notice === undefined ? {} : { notice, noticeTone: 'warning' as const }),
      onSelect: (name) => {
        const skill = byName.get(name);
        const commandName = skill === undefined ? undefined : skillSlashCommandName(skill);
        host.restoreEditor();
        if (commandName === undefined) {
          host.showStatus(`Skill "${name}" is not slash-invocable.`, 'warning');
          return;
        }
        host.restoreInputText(`/${commandName} `);
      },
      onCancel: () => host.restoreEditor(),
    }),
  );
}
