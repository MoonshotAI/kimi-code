import {
  createKimiHarness,
  createKimiHarnessV2,
  type KimiHarness,
  type SkillDiscoveryReport,
  type SkillSummary,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { isKimiV2Enabled } from '../experimental-v2';
import { createKimiCodeHostIdentity } from '../version';
import { skillSlashCommandName } from '../../tui/commands/skills';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface SkillsListDeps {
  readonly cwd: () => string;
  readonly inspectWorkspaceSkills: (workDir: string) => Promise<SkillDiscoveryReport>;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly close: () => Promise<void>;
}

export interface SkillsListOptions {
  readonly json: boolean;
}

interface ListedSkill extends SkillSummary {
  readonly slashCommand: string | null;
}

export async function handleSkillsList(
  deps: SkillsListDeps,
  options: SkillsListOptions,
): Promise<void> {
  const report = await deps.inspectWorkspaceSkills(deps.cwd());
  if (options.json) {
    deps.stdout.write(`${JSON.stringify(toSerializableReport(report), null, 2)}\n`);
    return;
  }
  deps.stdout.write(formatSkillsReport(report));
}

export function formatSkillsReport(report: SkillDiscoveryReport): string {
  const lines = [
    `${String(report.skills.length)} ${report.skills.length === 1 ? 'skill' : 'skills'} loaded.`,
  ];
  for (const skill of report.skills) {
    const commandName = skillSlashCommandName(skill);
    const command = commandName === undefined ? 'not slash-invocable' : `/${commandName}`;
    lines.push('', `${command}  ${skill.name}  [${skill.source} · ${skill.type ?? 'inline'}]`);
    if (skill.description.length > 0) lines.push(`  ${skill.description}`);
    lines.push(`  ${skill.path}`);
  }
  if (report.diagnostics.length > 0) {
    lines.push(
      '',
      `${String(report.diagnostics.length)} discovery ${report.diagnostics.length === 1 ? 'issue' : 'issues'}:`,
    );
    for (const diagnostic of report.diagnostics) {
      lines.push(`- [${diagnostic.type}] ${diagnostic.path}: ${diagnostic.reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function registerSkillsCommand(
  parent: Command,
  version: string,
  deps?: Partial<SkillsListDeps>,
): void {
  const skills = parent.command('skills').description('Inspect skills available in this workspace.');
  skills
    .command('list')
    .description('List loaded skills and discovery issues.')
    .option('--json', 'Emit a machine-readable discovery report.', false)
    .action(async (options: { json?: boolean }) => {
      const rootOptions = parent.opts<{ skillsDir?: string[] }>();
      const resolved = resolveDeps(version, deps, rootOptions.skillsDir ?? []);
      try {
        await handleSkillsList(resolved, { json: options.json === true });
      } catch (error) {
        resolved.stderr.write(`Failed to list skills: ${errorMessage(error)}\n`);
        resolved.exit(1);
      } finally {
        await resolved.close();
      }
    });
}

function toSerializableReport(report: SkillDiscoveryReport): {
  readonly skills: readonly ListedSkill[];
  readonly diagnostics: SkillDiscoveryReport['diagnostics'];
} {
  return {
    skills: report.skills.map((skill) => ({
      ...skill,
      slashCommand: skillSlashCommandName(skill) ?? null,
    })),
    diagnostics: report.diagnostics,
  };
}

function resolveDeps(
  version: string,
  overrides: Partial<SkillsListDeps> = {},
  skillDirs: readonly string[] = [],
): SkillsListDeps {
  let harness: KimiHarness | undefined;
  const getHarness = (): KimiHarness => {
    harness ??= (isKimiV2Enabled() ? createKimiHarnessV2 : createKimiHarness)({
      identity: createKimiCodeHostIdentity(version),
      skillDirs,
    });
    return harness;
  };
  return {
    cwd: overrides.cwd ?? (() => process.cwd()),
    inspectWorkspaceSkills:
      overrides.inspectWorkspaceSkills ?? ((workDir) => getHarness().inspectWorkspaceSkills(workDir)),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code) => process.exit(code)),
    close: overrides.close ?? (async () => harness?.close()),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
