import { createInterface } from 'node:readline/promises';

import type { Command } from 'commander';

import { listSessionsByRecency, type SessionListEntry } from '#/utils/sessions';

import { withSubHarness } from './harness';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ForkDeps {
  readonly listSessions: () => Promise<readonly SessionListEntry[]>;
  readonly forkSession: (id: string) => Promise<string>;
  readonly confirmPreviousSession: (entry: SessionListEntry) => Promise<boolean>;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

export interface ForkOptions {
  readonly yes: boolean;
}

export async function handleFork(
  deps: ForkDeps,
  sessionId: string | undefined,
  opts: ForkOptions,
): Promise<void> {
  let resolvedId = sessionId?.trim() ?? '';
  if (resolvedId.length === 0) {
    const latest = (await deps.listSessions())[0];
    if (latest === undefined) {
      deps.stderr.write('No previous session found to fork.\n');
      deps.exit(1);
    }
    if (!opts.yes && !(await deps.confirmPreviousSession(latest))) {
      deps.stdout.write('Fork cancelled.\n');
      return;
    }
    resolvedId = latest.id;
  }

  try {
    const forkedId = await deps.forkSession(resolvedId);
    deps.stdout.write(`Forked to ${forkedId}\n`);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    deps.exit(1);
  }
}

export function registerForkCommand(parent: Command, deps?: Partial<ForkDeps>): void {
  parent
    .command('fork')
    .description('Fork a session into a new session.')
    .option('-y, --yes', 'Skip previous-session confirmation.')
    .argument('[sessionId]', 'Session id to fork. Defaults to the most recent session.')
    .action(async (sessionId: string | undefined, options: { yes?: boolean }) => {
      await withSubHarness(async (harness) => {
        const resolved: ForkDeps = {
          listSessions: deps?.listSessions ?? (() => listSessionsByRecency(harness, process.cwd())),
          forkSession: deps?.forkSession ?? (async (id) => (await harness.forkSession(id)).id),
          confirmPreviousSession: deps?.confirmPreviousSession ?? confirmPreviousSession,
          stdout: deps?.stdout ?? process.stdout,
          stderr: deps?.stderr ?? process.stderr,
          exit: deps?.exit ?? ((code: number) => process.exit(code)),
        };
        await handleFork(resolved, sessionId, { yes: options.yes === true });
      });
    });
}

async function confirmPreviousSession(entry: SessionListEntry): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const title = entry.title === undefined ? entry.id : `${entry.title} (${entry.id})`;
    const answer = await rl.question(`Fork previous session "${title}"? [Y/n] `);
    const trimmed = answer.trim().toLowerCase();
    return trimmed === '' || trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}
