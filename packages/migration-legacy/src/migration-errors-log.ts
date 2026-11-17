import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { migrationErrorsLogFile } from './paths.js';

export interface MigrationFailureEntry {
  readonly sourcePath: string;
  readonly reason: string;
}

export interface MigrationErrorsLogInput {
  readonly startedAt: string;
  readonly failures: readonly MigrationFailureEntry[];
}

export async function writeMigrationErrorsLog(
  targetHome: string,
  input: MigrationErrorsLogInput,
): Promise<void> {
  const lines: string[] = [`===== migration run @ ${input.startedAt} =====`];

  if (input.failures.length === 0) {
    lines.push('no failures.', '');
  } else {
    lines.push(`${input.failures.length} session(s) failed to migrate.`, '');
    let index = 0;
    for (const failure of input.failures) {
      index += 1;
      lines.push(
        `[${index}] ${basename(failure.sourcePath)}`,
        `  source: ${failure.sourcePath}`,
        `  reason: ${failure.reason}`,
        `  ${await describeContext(failure.sourcePath)}`,
        '',
      );
    }
  }

  try {
    await mkdir(targetHome, { recursive: true, mode: 0o700 });
    await appendFile(migrationErrorsLogFile(targetHome), lines.join('\n'), {
      mode: 0o600,
    });
  } catch {}
}

async function describeContext(sessionDir: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(join(sessionDir, 'context.jsonl'), 'utf-8');
  } catch {
    return 'context.jsonl: unreadable';
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const roleCounts = new Map<string, number>();
  for (const line of lines) {
    let role = '<unparseable>';
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        const raw = (parsed as Record<string, unknown>)['role'];
        role = typeof raw === 'string' ? raw : '<no-role>';
      }
    } catch {}
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }
  const histogram = [...roleCounts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([role, count]) => `${role}=${count}`)
    .join(' ');
  return `context.jsonl: ${lines.length} lines${histogram === '' ? '' : ` - ${histogram}`}`;
}
