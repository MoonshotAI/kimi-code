/**
 * `kimi session` sub-command group.
 *
 * CLI glue only: listing semantics (workspace scoping, recency order,
 * archived filtering) are owned by the SDK/engine; this file parses options
 * and formats rows.
 */

import { setTelemetryContext, track, withTelemetryContext } from '@moonshot-ai/kimi-telemetry';
import {
  createKimiHarness,
  createKimiHarnessV2,
  type KimiHarness,
  type ListSessionsOptions,
  type SessionSummary,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { createCliTelemetryBootstrap } from '#/cli/telemetry';
import { createKimiCodeHostIdentity } from '#/cli/version';

import { isKimiV2Enabled } from '../experimental-v2';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface SessionListDeps {
  readonly listSessions: (options: ListSessionsOptions) => Promise<readonly SessionSummary[]>;
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

export interface SessionListOptions {
  readonly all: boolean;
  readonly archived: boolean;
  readonly cwd?: string;
  readonly limit?: number;
  readonly json: boolean;
}

export async function handleSessionList(
  deps: SessionListDeps,
  opts: SessionListOptions,
): Promise<void> {
  const workDir = opts.all ? undefined : (opts.cwd ?? deps.cwd());
  const sessions = await deps.listSessions({
    workDir,
    includeArchived: opts.archived ? true : undefined,
  });
  const limited = opts.limit === undefined ? sessions : sessions.slice(0, opts.limit);
  if (opts.json) {
    deps.stdout.write(`${JSON.stringify(limited, null, 2)}\n`);
    return;
  }
  if (limited.length === 0) {
    deps.stdout.write('No sessions found.\n');
    return;
  }
  for (const summary of limited) {
    deps.stdout.write(`${formatRow(summary, opts.all)}\n`);
  }
}

export function registerSessionCommand(parent: Command, deps?: Partial<SessionListDeps>): void {
  const session = parent.command('session').description('Manage sessions non-interactively.');

  session
    .command('list')
    .description('List sessions, most recently updated first.')
    .option('--cwd <path>', 'List sessions of this working directory. Defaults to the current directory.')
    .option('--all', 'List sessions across every workspace.', false)
    .option('--archived', 'Include archived sessions.', false)
    .option('--limit <n>', 'Print at most n sessions.', parseLimitOption)
    .option('--json', 'Emit the session summaries as JSON.', false)
    .action(async (options: { cwd?: string; all?: boolean; archived?: boolean; limit?: number; json?: boolean }) => {
      const resolved = createDefaultSessionListDeps(deps);
      try {
        await handleSessionList(resolved, {
          all: options.all === true,
          archived: options.archived === true,
          cwd: options.cwd,
          limit: options.limit,
          json: options.json === true,
        });
      } catch (error) {
        resolved.stderr.write(`${errorMessage(error)}\n`);
        resolved.exit(1);
      } finally {
        await resolved.close();
      }
    });
}

function createDefaultSessionListDeps(
  overrides: Partial<SessionListDeps> = {},
): SessionListDeps & { readonly close: () => Promise<void> } {
  let harness: KimiHarness | undefined;
  const identity = createKimiCodeHostIdentity();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const getHarness = (): KimiHarness => {
    harness ??= (isKimiV2Enabled() ? createKimiHarnessV2 : createKimiHarness)({
      homeDir: createCliTelemetryBootstrap().homeDir,
      identity,
      telemetry: telemetryClient,
    });
    return harness;
  };
  return {
    listSessions:
      overrides.listSessions ??
      ((options: ListSessionsOptions) => getHarness().listSessions(options)),
    cwd: overrides.cwd ?? (() => process.cwd()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
    close: async () => {
      await harness?.close();
    },
  };
}

function formatRow(summary: SessionSummary, showWorkDir: boolean): string {
  const archived = summary.archived === true ? ' [archived]' : '';
  const title = sanitizeField(summary.title ?? summary.lastPrompt ?? '');
  const base = `${formatTimestamp(summary.updatedAt)}  ${summary.id}  ${title}${archived}`;
  return showWorkDir ? `${base}  ${sanitizeField(summary.workDir)}` : base;
}

function sanitizeField(value: string): string {
  return value.replaceAll(/[\x00-\x1f\x7f]+/g, ' ').trim();
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
