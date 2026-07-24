/**
 * `kimi import` sub-command.
 *
 * Imports session context from external AI coding tools (Claude Code, etc.)
 * into a new Kimi Code session. The imported context is injected via the
 * existing `session.importContext()` RPC, persisted, and resumable with
 * `kimi -r <session-id>`.
 *
 * Usage:
 *   kimi import --from claude-code                    # interactive picker → new session
 *   kimi import --from claude-code --session <id>     # specific CC session
 *   kimi import --file handoff.md                     # from a handoff file
 *   kimi import --from claude-code --print            # print handoff to stdout only
 *   kimi import --from claude-code --prompt "..."     # import + send follow-up prompt
 */

import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';
import {
  createKimiHarness,
  resolveKimiHome,
  type KimiHarness,
  type SessionSummary,
  type ShellEnvironment,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_UI_MODE } from '#/constant/app';
import { createCliTelemetryBootstrap, initializeCliTelemetry } from '#/cli/telemetry';
import { detectInstallSource } from '#/cli/update/source';
import { createKimiCodeHostIdentity } from '#/cli/version';
import { detectShellEnvironment } from '#/utils/process/shell-env';

import { claudeCodeParser } from '../import/sources/claude-code';
import type { SourceParser, SourceSessionSummary } from '../import/sources/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WritableLike {
  write(chunk: string): boolean;
}

interface ImportDeps {
  readonly listSessions: (workDir: string) => Promise<readonly SessionSummary[]>;
  readonly getSourceParsers: () => SourceParser[];
  readonly getInstallSource: () => Promise<string>;
  readonly getShellEnv: () => ShellEnvironment;
  readonly version: string;
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly harnessFactory: () => KimiHarness;
}

interface ImportOptions {
  from?: string;
  session?: string;
  file?: string;
  print: boolean;
  prompt?: string;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleImport(deps: ImportDeps, opts: ImportOptions): Promise<void> {
  const parsers = deps.getSourceParsers();

  // --file mode: read a handoff file directly
  if (opts.file !== undefined) {
    await handleFileImport(deps, opts.file, opts);
    return;
  }

  // --from mode: use a source parser
  if (opts.from !== undefined) {
    const parser = parsers.find((p) => p.sourceId === opts.from);
    if (parser === undefined) {
      const available = parsers.map((p) => p.sourceId).join(', ');
      deps.stderr.write(
        `Unknown source: ${opts.from}. Available sources: ${available || '(none)'}\n`,
      );
      deps.exit(1);
    }
    await handleSourceImport(deps, parser, opts);
    return;
  }

  // No mode specified — show available sources
  deps.stderr.write('Usage: kimi import --from <source> [--session <id>]\n');
  deps.stderr.write('       kimi import --file <handoff.md>\n\n');
  deps.stderr.write('Available sources:\n');
  for (const parser of parsers) {
    deps.stderr.write(`  ${parser.sourceId}  — ${parser.label}\n`);
  }
  if (parsers.length === 0) {
    deps.stderr.write('  (no source parsers available)\n');
  }
  deps.exit(1);
}

async function handleFileImport(
  deps: ImportDeps,
  filePath: string,
  opts: ImportOptions,
): Promise<void> {
  const resolved = resolve(deps.cwd(), filePath);
  let content: string;
  try {
    content = await readFile(resolved, 'utf-8');
  } catch (error) {
    deps.stderr.write(`Failed to read file: ${errorMessage(error)}\n`);
    deps.exit(1);
  }

  if (content.trim().length === 0) {
    deps.stderr.write('Handoff file is empty.\n');
    deps.exit(1);
  }

  if (opts.print) {
    deps.stdout.write(content);
    return;
  }

  await importIntoSession(deps, content, 'handoff-file', opts);
}

async function handleSourceImport(
  deps: ImportDeps,
  parser: SourceParser,
  opts: ImportOptions,
): Promise<void> {
  let sessionId = opts.session;

  if (sessionId === undefined) {
    const sessions = await parser.listSessions();
    if (sessions.length === 0) {
      deps.stderr.write(`No ${parser.label} sessions found.\n`);
      deps.exit(1);
    }

    sessionId = await pickSession(deps, sessions);
    if (sessionId === undefined) {
      deps.stdout.write('Import cancelled.\n');
      return;
    }
  }

  let ctx;
  try {
    ctx = await parser.parseSession(sessionId);
  } catch (error) {
    deps.stderr.write(`Failed to parse session: ${errorMessage(error)}\n`);
    deps.exit(1);
  }

  const markdown = ctx.markdown;

  if (opts.print) {
    deps.stdout.write(markdown);
    return;
  }

  await importIntoSession(deps, markdown, parser.sourceId, opts);
}

async function importIntoSession(
  deps: ImportDeps,
  content: string,
  source: string,
  opts: ImportOptions,
): Promise<void> {
  const harness = deps.harnessFactory();

  try {
    await harness.ensureConfigFile();
    const config = await harness.getConfig();

    const telemetryBootstrap = createCliTelemetryBootstrap();
    initializeCliTelemetry({
      harness,
      bootstrap: telemetryBootstrap,
      config,
      version: deps.version,
      uiMode: CLI_UI_MODE,
    });

    const workDir = deps.cwd();
    deps.stderr.write(`Creating session (workdir: ${workDir})...\n`);
    const session = await harness.createSession({
      workDir,
      model: config.defaultModel,
      permission: 'manual',
      drainAgentTasksOnStop: true,
    });

    deps.stderr.write(`Importing context from ${source}...\n`);
    await session.importContext(content, source);

    if (opts.prompt !== undefined) {
      deps.stderr.write('Sending follow-up prompt...\n');

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let mainTurnActive = false;
        const PROMPT_MAIN_AGENT_ID = 'main';
        const unsubscribe = session.onEvent((event) => {
          if (settled) return;

          if (event.type === 'error') {
            // Only fail on main-agent errors; subagent errors are recoverable
            if ('agentId' in event && event.agentId !== PROMPT_MAIN_AGENT_ID) return;
            settled = true;
            unsubscribe();
            reject(new Error(`${event.code}: ${event.message}`));
            return;
          }

          if (event.type === 'turn.started') {
            if ('agentId' in event && event.agentId === PROMPT_MAIN_AGENT_ID) {
              mainTurnActive = true;
            }
            return;
          }

          if (event.type === 'turn.ended') {
            // Ignore subagent and non-main turns
            if (!mainTurnActive) return;
            if ('agentId' in event && event.agentId !== PROMPT_MAIN_AGENT_ID) return;

            if (event.reason === 'completed') {
              settled = true;
              unsubscribe();
              resolve();
              return;
            }
            // Non-completed: error, blocked, or cancelled
            settled = true;
            unsubscribe();
            const msg =
              event.error !== undefined
                ? `${event.error.code}: ${event.error.message}`
                : `Turn ended with reason: ${event.reason}`;
            reject(new Error(msg));
            return;
          }
        });

        session.setApprovalHandler(() => ({ decision: 'approved' }));
        session.setQuestionHandler(() => null);

        session.prompt(opts.prompt!).catch((error: unknown) => {
          if (!settled) {
            settled = true;
            unsubscribe();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    }

    await session.close();

    deps.stdout.write(`\n✓ Session imported successfully.\n`);
    deps.stdout.write(`Session ID: ${session.id}\n`);
    deps.stdout.write(`Resume with: kimi -r ${session.id}\n`);
    if (opts.prompt === undefined) {
      deps.stdout.write(`Tip: Use --prompt "Continue the work" to let the model process the imported context.\n`);
    }
  } finally {
    try {
      await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
    } catch {
      // Best-effort
    }
    await harness.close().catch(() => {});
  }
}

async function pickSession(
  deps: ImportDeps,
  sessions: readonly SourceSessionSummary[],
): Promise<string | undefined> {
  deps.stderr.write('\nAvailable sessions:\n\n');
  for (let i = 0; i < Math.min(sessions.length, 20); i++) {
    const s = sessions[i]!;
    const idx = String(i + 1).padStart(2, ' ');
    const title = s.title ?? '(untitled)';
    const date = s.updatedAt?.slice(0, 10) ?? s.createdAt?.slice(0, 10) ?? '';
    deps.stderr.write(`  ${idx}. [${date}] ${truncate(title, 60)}\n`);
    if (s.workingDirectory !== undefined) {
      deps.stderr.write(`      ${s.workingDirectory}\n`);
    }
  }
  deps.stderr.write('\n');

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('Select a session (number, or Enter to cancel): ');
    const trimmed = answer.trim();
    if (trimmed === '') return undefined;
    const index = Number.parseInt(trimmed, 10);
    if (Number.isNaN(index) || index < 1 || index > sessions.length) {
      deps.stderr.write('Invalid selection.\n');
      return undefined;
    }
    return sessions[index - 1]?.sessionId;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export interface ImportSubdeps {
  readonly getSourceParsers?: () => SourceParser[];
  readonly listSessions?: (workDir: string) => Promise<readonly SessionSummary[]>;
  readonly getInstallSource?: () => Promise<string>;
  readonly getShellEnv?: () => ShellEnvironment;
  readonly version?: string;
  readonly cwd?: () => string;
  readonly stdout?: WritableLike;
  readonly stderr?: WritableLike;
  readonly exit?: (code: number) => never;
}

export function registerImportCommand(parent: Command, deps: ImportSubdeps = {}): void {
  parent
    .command('import')
    .description('Import session context from another AI coding tool.')
    .option('--from <source>', 'Source tool (e.g. claude-code).')
    .option('--session <id>', 'Session ID from the source tool to import.')
    .option('--file <path>', 'Import from a handoff Markdown file instead of a source tool.')
    .option('--prompt <text>', 'Follow-up prompt to send after importing context.')
    .option(
      '--print',
      'Print the handoff context to stdout instead of importing into a session.',
      false,
    )
    .action(async (options: ImportOptions) => {
      await handleImport(createDefaultDeps(deps), options);
    });
}

// ---------------------------------------------------------------------------
// Default dependencies
// ---------------------------------------------------------------------------

function createDefaultDeps(overrides: ImportSubdeps): ImportDeps {
  const identity = createKimiCodeHostIdentity();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };

  const harnessFactory = (): KimiHarness => {
    return createKimiHarness({
      homeDir: resolveKimiHome(),
      identity,
      telemetry: telemetryClient,
    });
  };

  return {
    listSessions:
      overrides.listSessions ??
      ((workDir: string) =>
        harnessFactory().listSessions({ workDir })),
    getSourceParsers: overrides.getSourceParsers ?? (() => [claudeCodeParser]),
    version: overrides.version ?? identity.version,
    getInstallSource: overrides.getInstallSource ?? (() => detectInstallSource()),
    getShellEnv: overrides.getShellEnv ?? detectShellEnvironment,
    cwd: overrides.cwd ?? (() => process.cwd()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
    harnessFactory,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
