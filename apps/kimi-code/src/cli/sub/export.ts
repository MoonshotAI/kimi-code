import { createInterface } from 'node:readline/promises';

import type { ExportSessionResult, ShellEnvironment } from '@moonshot-ai/harness-core';
import type { Command } from 'commander';

import { detectInstallSource } from '#/cli/update/source';
import { detectShellEnvironment } from '#/utils/process/shell-env';
import { listSessionsByRecency, type SessionListEntry } from '#/utils/sessions';

import { withSubHarness } from './harness';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ExportDeps {
  readonly listSessions: () => Promise<readonly SessionListEntry[]>;
  readonly exportSession: (
    id: string,
    opts: {
      readonly outputPath?: string;
      readonly includeGlobalLog?: boolean;
      readonly installSource?: string;
      readonly shellEnv?: ShellEnvironment;
    },
  ) => Promise<ExportSessionResult>;
  readonly confirmPreviousSession: (entry: SessionListEntry) => Promise<boolean>;
  readonly getInstallSource: () => Promise<string>;
  readonly getShellEnv: () => ShellEnvironment;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

export interface ExportOptions {
  readonly yes: boolean;
  readonly includeGlobalLog: boolean;
}

export async function handleExport(
  deps: ExportDeps,
  sessionId: string | undefined,
  output: string | undefined,
  opts: ExportOptions,
): Promise<void> {
  let resolvedId = sessionId?.trim() ?? '';
  if (resolvedId.length === 0) {
    const latest = (await deps.listSessions())[0];
    if (latest === undefined) {
      deps.stderr.write('No previous session found to export.\n');
      deps.exit(1);
    }
    if (!opts.yes && !(await deps.confirmPreviousSession(latest))) {
      deps.stdout.write('Export cancelled.\n');
      return;
    }
    resolvedId = latest.id;
  }

  try {
    const installSource = await deps.getInstallSource();
    const shellEnv = deps.getShellEnv();
    const result = await deps.exportSession(resolvedId, {
      outputPath: output,
      includeGlobalLog: opts.includeGlobalLog,
      installSource,
      shellEnv,
    });
    deps.stdout.write(`${result.zipPath}\n`);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    deps.exit(1);
  }
}

export function registerExportCommand(parent: Command, deps?: Partial<ExportDeps>): void {
  parent
    .command('export')
    .description('Export a session as a ZIP archive.')
    .option('-o, --output <path>', 'Output ZIP path.')
    .option('-y, --yes', 'Skip previous-session confirmation.')
    .option(
      '--no-include-global-log',
      'Skip bundling the active global diagnostic log (~/.kimi-code/logs/kimi-code.log, not rotated .1 files). By default the global log is included.',
    )
    .argument('[sessionId]', 'Session id to export. Defaults to the most recent session.')
    .action(
      async (
        sessionId: string | undefined,
        options: { output?: string; yes?: boolean; includeGlobalLog?: boolean },
      ) => {
        await withSubHarness(async (harness) => {
          const resolved: ExportDeps = {
            listSessions:
              deps?.listSessions ?? (() => listSessionsByRecency(harness, process.cwd())),
            exportSession:
              deps?.exportSession ?? ((id, opts) => harness.exportSession(id, opts)),
            confirmPreviousSession: deps?.confirmPreviousSession ?? confirmPreviousSession,
            getInstallSource: deps?.getInstallSource ?? (() => detectInstallSource()),
            getShellEnv: deps?.getShellEnv ?? detectShellEnvironment,
            stdout: deps?.stdout ?? process.stdout,
            stderr: deps?.stderr ?? process.stderr,
            exit: deps?.exit ?? ((code: number) => process.exit(code)),
          };
          await handleExport(resolved, sessionId, options.output, {
            yes: options.yes === true,
            includeGlobalLog: options.includeGlobalLog !== false,
          });
        });
      },
    );
}

async function confirmPreviousSession(entry: SessionListEntry): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const title = entry.title === undefined ? entry.id : `${entry.title} (${entry.id})`;
    const answer = await rl.question(`Export previous session "${title}"? [Y/n] `);
    const trimmed = answer.trim().toLowerCase();
    return trimmed === '' || trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}
