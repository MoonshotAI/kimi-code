/**
 * Kimi Code entry point.
 *
 * Parses CLI arguments via Commander.js, validates options, runs the
 * outer update preflight, then delegates to the requested UI runner.
 */

import {
  createKimiHarness,
  flushDiagnosticLogs,
  log,
  resolveGlobalLogPath,
  resolveKimiHome,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import {
  installCrashHandlers,
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';

import { createProgram } from './cli/commands';
import type { CLIOptions } from './cli/options';
import { OptionConflictError, validateOptions } from './cli/options';
import { runPrompt } from './cli/run-prompt';
import { runShell } from './cli/run-shell';
import { formatStartupError } from './cli/startup-error';
import { runPluginNodeEntry } from './cli/sub/plugin-run-node';
import { handleUpgrade } from './cli/sub/upgrade';
import { createCliTelemetryBootstrap, initializeCliTelemetry } from './cli/telemetry';
import { runUpdatePreflight } from './cli/update/preflight';
import { createKimiCodeHostIdentity, getVersion } from './cli/version';
import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_UI_MODE, PROCESS_NAME } from './constant/app';
import { cleanupStaleNativeCacheForCurrent } from './native/native-assets';
import { installNativeModuleHook } from './native/module-hook';
import { runNativeAssetSmokeIfRequested } from './native/smoke';

export async function handleMainCommand(opts: CLIOptions, version: string): Promise<void> {
  let validated: ReturnType<typeof validateOptions>;
  try {
    validated = validateOptions(opts);
  } catch (error) {
    if (error instanceof OptionConflictError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const preflightResult = await runUpdatePreflight(
    version,
    validated.uiMode === 'print' ? { track, isTTY: false } : { track },
  );
  if (preflightResult === 'exit') {
    process.exit(0);
  }

  if (validated.uiMode === 'print') {
    await runPrompt(validated.options, version);
    return;
  }

  await runShell(validated.options, version);
}

/** `kimi migrate`: launch the migration screen only, then exit. */
async function handleMigrateCommand(version: string): Promise<void> {
  await runShell(MIGRATE_CLI_OPTIONS, version, { migrateOnly: true });
}

export async function handleUpgradeCommand(version: string): Promise<void> {
  const telemetryBootstrap = createCliTelemetryBootstrap();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const harness = createKimiHarness({
    homeDir: telemetryBootstrap.homeDir,
    identity: createKimiCodeHostIdentity(version),
    telemetry: telemetryClient,
  });
  let exitCode = 1;
  try {
    await harness.ensureConfigFile();
    const config = await harness.getConfig();
    initializeCliTelemetry({
      harness,
      bootstrap: telemetryBootstrap,
      config,
      version,
      uiMode: CLI_UI_MODE,
    });
    exitCode = await handleUpgrade(version, { track, logger: log });
  } finally {
    await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS }).catch(() => {});
    await harness.close().catch(() => {});
  }
  process.exit(exitCode);
}

/** A neutral CLIOptions value — `kimi migrate` never opens a chat session. */
const MIGRATE_CLI_OPTIONS: CLIOptions = {
  session: undefined,
  continue: false,
  yolo: false,
  auto: false,
  plan: false,
  model: undefined,
  outputFormat: undefined,
  prompt: undefined,
  skillsDirs: [],
};

export function main(): void {
  process.title = PROCESS_NAME;
  installCrashHandlers();
  installNativeModuleHook();
  if (runNativeAssetSmokeIfRequested()) return;

  // Start the background cleanup of stale native cache. Fire-and-forget; must not block startup or throw.
  queueMicrotask(() => {
    try {
      cleanupStaleNativeCacheForCurrent();
    } catch {
      // ignore: cache GC must never affect process startup
    }
  });

  const version = getVersion();

  const program = createProgram(
    version,
    (opts) => {
      void handleMainCommand(opts, version).catch(async (error: unknown) => {
        const operation = opts.prompt !== undefined ? 'run prompt' : 'start shell';
        await logStartupFailure(operation, error);
        process.stderr.write(
          formatStartupError(error, {
            operation,
          }),
        );
        process.stderr.write(`See log: ${resolveGlobalLogPath(resolveKimiHome())}\n`);
        process.exit(1);
      });
    },
    () => {
      void handleMigrateCommand(version).catch(async (error: unknown) => {
        await logStartupFailure('run migration', error);
        process.stderr.write(formatStartupError(error, { operation: 'run migration' }));
        process.stderr.write(`See log: ${resolveGlobalLogPath(resolveKimiHome())}\n`);
        process.exit(1);
      });
    },
    (entry, args) => {
      void runPluginNodeEntry(entry, args).catch(async (error: unknown) => {
        await logStartupFailure('run plugin node entry', error);
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    },
    () => {
      void handleUpgradeCommand(version).catch(async (error: unknown) => {
        await logStartupFailure('upgrade', error);
        process.stderr.write(formatStartupError(error, { operation: 'upgrade' }));
        process.stderr.write(`See log: ${resolveGlobalLogPath(resolveKimiHome())}\n`);
        process.exit(1);
      });
    },
  );

  program.parse(process.argv);
}

main();

async function logStartupFailure(operation: string, error: unknown): Promise<void> {
  log.error('startup failed', { operation, error });
  try {
    await flushDiagnosticLogs();
  } catch {
    // Best-effort diagnostic flush only.
  }
}
