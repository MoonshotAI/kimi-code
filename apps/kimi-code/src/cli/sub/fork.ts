import { createInterface } from 'node:readline/promises';

import {
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';
import {
  createKimiHarness,
  createKimiHarnessV2,
  type KimiHarness,
  type SessionSummary,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_UI_MODE } from '#/constant/app';
import { createCliTelemetryBootstrap, initializeCliTelemetry } from '#/cli/telemetry';
import { createKimiCodeHostIdentity } from '#/cli/version';
import { isKimiV2Enabled } from '../experimental-v2';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface ForkedSessionResult {
  readonly id: string;
  readonly title?: string | undefined;
}

export interface ForkDeps {
  readonly listSessions: (workDir: string) => Promise<readonly SessionSummary[]>;
  readonly forkSession: (sessionId: string) => Promise<ForkedSessionResult>;
  readonly confirmPreviousSession: (summary: SessionSummary) => Promise<boolean>;
  readonly cwd: () => string;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

export interface ForkOptions {
  readonly yes: boolean;
  readonly cwd?: string | undefined;
}

export async function handleFork(
  deps: ForkDeps,
  sessionId: string | undefined,
  opts: ForkOptions,
): Promise<void> {
  let resolvedId = normalizeOptionalSessionId(sessionId);
  if (resolvedId === undefined) {
    const sessions = await deps.listSessions(opts.cwd ?? deps.cwd());
    const latest = sessions[0];
    if (latest === undefined) {
      deps.stderr.write('No previous session found to fork.\n');
      deps.exit(1);
    }
    if (!opts.yes) {
      const confirmed = await deps.confirmPreviousSession(latest);
      if (!confirmed) {
        deps.stdout.write('Fork cancelled.\n');
        return;
      }
    }
    resolvedId = latest.id;
  }

  const startedAt = Date.now();
  try {
    const forked = await deps.forkSession(resolvedId);
    const elapsedMs = Date.now() - startedAt;
    const title = forked.title === undefined ? '' : ` ("${forked.title}")`;
    deps.stdout.write(`Forked to ${forked.id}${title} in ${elapsedMs}ms\n`);
  } catch (error) {
    deps.stderr.write(`${errorMessage(error)}\n`);
    deps.exit(1);
  }
}

export function registerForkCommand(parent: Command, deps?: Partial<ForkDeps>): void {
  parent
    .command('fork')
    .description('Fork a session into a new session.')
    .option(
      '--cwd <path>',
      'Working directory used to find the most recent session to fork. Defaults to the current directory.',
    )
    .option('-y, --yes', 'Skip previous-session confirmation.')
    .argument('[sessionId]', 'Session id to fork. Defaults to the most recent session.')
    .action(async (sessionId: string | undefined, options: { cwd?: string; yes?: boolean }) => {
      const resolved = createDefaultForkDeps(deps);
      try {
        await handleFork(resolved, sessionId, {
          yes: options.yes === true,
          cwd: options.cwd,
        });
      } finally {
        await resolved.close();
      }
    });
}

function createDefaultForkDeps(overrides: Partial<ForkDeps> = {}): ForkDeps & {
  readonly close: () => Promise<void>;
} {
  let harness: KimiHarness | undefined;
  let telemetryBootstrap: ReturnType<typeof createCliTelemetryBootstrap> | undefined;
  let telemetryInitialized = false;
  let telemetryShutdown = false;
  const identity = createKimiCodeHostIdentity();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const getTelemetryBootstrap = (): ReturnType<typeof createCliTelemetryBootstrap> => {
    telemetryBootstrap ??= createCliTelemetryBootstrap();
    return telemetryBootstrap;
  };
  const getHarness = (): KimiHarness => {
    const currentTelemetryBootstrap = getTelemetryBootstrap();
    harness ??= (isKimiV2Enabled() ? createKimiHarnessV2 : createKimiHarness)({
      homeDir: currentTelemetryBootstrap.homeDir,
      identity,
      telemetry: telemetryClient,
    });
    return harness;
  };
  const initializeDefaultTelemetry = async (): Promise<void> => {
    if (telemetryInitialized) return;
    const currentTelemetryBootstrap = getTelemetryBootstrap();
    const currentHarness = getHarness();
    await currentHarness.ensureConfigFile();
    const config = await currentHarness.getConfig();
    initializeCliTelemetry({
      harness: currentHarness,
      bootstrap: currentTelemetryBootstrap,
      config,
      version: identity.version,
      uiMode: CLI_UI_MODE,
    });
    telemetryInitialized = true;
  };
  const shutdownDefaultTelemetry = async (): Promise<void> => {
    if (!telemetryInitialized || telemetryShutdown) return;
    telemetryShutdown = true;
    await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
  };
  return {
    listSessions:
      overrides.listSessions ??
      ((workDir: string) =>
        getHarness().listSessions({
          workDir,
        })),
    forkSession:
      overrides.forkSession ??
      (async (sessionId: string) => {
        await initializeDefaultTelemetry();
        try {
          const forked = await getHarness().forkSession({ id: sessionId });
          return { id: forked.id, title: forked.summary?.title };
        } finally {
          await shutdownDefaultTelemetry();
        }
      }),
    confirmPreviousSession: overrides.confirmPreviousSession ?? confirmPreviousSession,
    cwd: overrides.cwd ?? (() => process.cwd()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
    close: async () => {
      await harness?.close();
    },
  };
}

function normalizeOptionalSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

async function confirmPreviousSession(summary: SessionSummary): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const title = summary.title === undefined ? summary.id : `${summary.title} (${summary.id})`;
    const answer = await rl.question(`Fork previous session "${title}"? [Y/n] `);
    const trimmed = answer.trim().toLowerCase();
    return trimmed === '' || trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
