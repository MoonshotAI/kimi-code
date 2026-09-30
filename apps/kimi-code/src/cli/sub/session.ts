import type { Command } from 'commander';

import { listSessionsByRecency, type SessionListEntry } from '#/utils/sessions';

import { withSubHarness } from './harness';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface SessionDeps {
  readonly listSessions: () => Promise<readonly SessionListEntry[]>;
  readonly deleteSession: (id: string) => Promise<void>;
  readonly renameSession: (id: string, title: string) => Promise<void>;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

export interface SessionListOptions {
  readonly limit?: number;
  readonly json: boolean;
}

export async function handleSessionList(
  deps: SessionDeps,
  opts: SessionListOptions,
): Promise<void> {
  const sessions = await deps.listSessions();
  const limited = opts.limit === undefined ? sessions : sessions.slice(0, opts.limit);
  if (opts.json) {
    deps.stdout.write(`${JSON.stringify(limited, null, 2)}\n`);
    return;
  }
  if (limited.length === 0) {
    deps.stdout.write('No sessions found.\n');
    return;
  }
  for (const entry of limited) {
    deps.stdout.write(`${formatRow(entry)}\n`);
  }
}

export async function handleSessionDelete(deps: SessionDeps, id: string): Promise<void> {
  try {
    await deps.deleteSession(id);
    deps.stdout.write(`Deleted session ${id}.\n`);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    deps.exit(1);
  }
}

export async function handleSessionRename(
  deps: SessionDeps,
  id: string,
  title: string,
): Promise<void> {
  try {
    await deps.renameSession(id, title);
    deps.stdout.write(`Renamed session ${id}.\n`);
  } catch (error) {
    deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    deps.exit(1);
  }
}

export function registerSessionCommand(parent: Command, deps?: Partial<SessionDeps>): void {
  const session = parent.command('session').description('Manage sessions non-interactively.');

  const run = (action: (resolved: SessionDeps) => Promise<void>): Promise<void> =>
    withSubHarness(async (harness) => {
      const resolved: SessionDeps = {
        listSessions: deps?.listSessions ?? (() => listSessionsByRecency(harness, process.cwd())),
        deleteSession: deps?.deleteSession ?? ((id) => harness.deleteSession(id)),
        renameSession: deps?.renameSession ?? ((id, title) => harness.renameSession(id, title)),
        stdout: deps?.stdout ?? process.stdout,
        stderr: deps?.stderr ?? process.stderr,
        exit: deps?.exit ?? ((code: number) => process.exit(code)),
      };
      await action(resolved);
    });

  session
    .command('list')
    .description('List sessions of the current workspace, most recently updated first.')
    .option('--limit <n>', 'Print at most n sessions.', parseLimitOption)
    .option('--json', 'Emit the session summaries as JSON.', false)
    .action(async (options: { limit?: number; json?: boolean }) => {
      await run((resolved) =>
        handleSessionList(resolved, { limit: options.limit, json: options.json === true }),
      );
    });

  session
    .command('delete <id>')
    .description('Delete a session of the current workspace.')
    .action(async (id: string) => {
      await run((resolved) => handleSessionDelete(resolved, id));
    });

  session
    .command('rename <id> <title>')
    .description('Rename a session of the current workspace.')
    .action(async (id: string, title: string) => {
      await run((resolved) => handleSessionRename(resolved, id, title));
    });
}

function formatRow(entry: SessionListEntry): string {
  const title = sanitizeField(entry.title ?? '');
  const base = `${formatTimestamp(entry.updatedAtMs)}  ${entry.id}`;
  return title.length === 0 ? base : `${base}  ${title}`;
}

function sanitizeField(value: string): string {
  return value.replaceAll(/[\u0000-\u001F\u007F]+/g, ' ').trim();
}

function formatTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLimitOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--limit must be a positive integer, got "${value}"`);
  }
  return parsed;
}
