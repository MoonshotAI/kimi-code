import {
  createKimiHarness,
  type KimiHarness,
  type SessionSummary,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { createCliTelemetryBootstrap, initializeCliTelemetry } from '#/cli/telemetry';
import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_UI_MODE } from '#/constant/app';
import { createKimiCodeHostIdentity } from '#/cli/version';
import { shutdownTelemetry, track, withTelemetryContext } from '@moonshot-ai/kimi-telemetry';

interface SessionDeps {
  readonly archiveSession: (id: string) => Promise<SessionSummary>;
  readonly unarchiveSession: (id: string) => Promise<SessionSummary>;
  readonly stdout: { write(chunk: string): boolean };
  readonly stderr: { write(chunk: string): boolean };
  readonly exit: (code: number) => never;
}

export function registerSessionCommand(parent: Command, deps?: Partial<SessionDeps>): void {
  const sessionCmd = parent.command('session').description('Manage sessions.');

  sessionCmd
    .command('archive <id>')
    .description('Archive a session, hiding it from the default session picker.')
    .action(async (id: string) => {
      const commandDeps = createDefaultSessionDeps(deps);
      try {
        const summary = await commandDeps.archiveSession(id.trim());
        commandDeps.stdout.write(`Archived session: ${summary.id}\n`);
      } catch (error) {
        commandDeps.stderr.write(`${errorMessage(error)}\n`);
        commandDeps.exit(1);
      }
    });

  sessionCmd
    .command('unarchive <id>')
    .description('Restore an archived session to the default session picker.')
    .action(async (id: string) => {
      const commandDeps = createDefaultSessionDeps(deps);
      try {
        const summary = await commandDeps.unarchiveSession(id.trim());
        commandDeps.stdout.write(`Unarchived session: ${summary.id}\n`);
      } catch (error) {
        commandDeps.stderr.write(`${errorMessage(error)}\n`);
        commandDeps.exit(1);
      }
    });
}

function createDefaultSessionDeps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  let harness: KimiHarness | undefined;
  const identity = createKimiCodeHostIdentity();
  const bootstrap = createCliTelemetryBootstrap();
  const getHarness = (): KimiHarness => {
    harness ??= createKimiHarness({
      homeDir: bootstrap.homeDir,
      identity,
      telemetry: {
        track,
        withContext: withTelemetryContext,
        setContext: () => {},
      },
    });
    return harness;
  };

  const withTelemetry = async <T>(fn: (h: KimiHarness) => Promise<T>): Promise<T> => {
    const h = getHarness();
    await h.ensureConfigFile();
    const config = await h.getConfig();
    initializeCliTelemetry({
      harness: h,
      bootstrap,
      config,
      version: identity.version,
      uiMode: CLI_UI_MODE,
    });
    try {
      return await fn(h);
    } finally {
      await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
    }
  };

  return {
    archiveSession:
      overrides.archiveSession ??
      (async (id: string) => {
        return withTelemetry((h) => h.archiveSession(id));
      }),
    unarchiveSession:
      overrides.unarchiveSession ??
      (async (id: string) => {
        return withTelemetry((h) => h.unarchiveSession(id));
      }),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
