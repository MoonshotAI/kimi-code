/**
 * Kimi Code CLI implementation.
 *
 * Loaded dynamically from the `src/main.ts` process entry after the
 * exec-server argv pre-dispatch, so the executor path never pays for the
 * SDK's full registration. Parses CLI arguments via Commander.js, validates
 * options, runs the outer update preflight, then delegates to the requested
 * UI runner.
 */

import {
  createKimiHarness,
  flushDiagnosticLogs,
  installGlobalProxyDispatcher,
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

import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_UI_MODE, PROCESS_NAME } from '#/constant/app';
import { runHeadlessMigrate, type MigrateCommandOptions } from '#/migration/index';
import { installMinidbTextBuildWorker } from '#/native/minidb-worker';
import { installNativeModuleHook } from '#/native/module-hook';
import { installKapSearchWorker } from '#/native/search-worker';
import { cleanupStaleNativeCacheForCurrent } from '#/native/native-assets';
import { runNativeAssetSmokeIfRequested } from '#/native/smoke';
import { startupTrace } from '#/utils/startup-trace';

import { createProgram } from './commands';
import { runExecServerCommand } from './exec-server';
import { finalizeHeadlessRun } from './headless-exit';
import type { CLIOptions } from './options';
import { OptionConflictError, validateOptions } from './options';
import { runPrompt } from './run-prompt';
import { runShell } from './run-shell';
import { formatStartupError } from './startup-error';
import { runPluginNodeEntry } from './sub/plugin-run-node';
import { runUpdateDownloadCommand } from './sub/update-download';
import { handleUpgrade } from './sub/upgrade';
import { createCliTelemetryBootstrap, initializeCliTelemetry } from './telemetry';
import { runUpdatePreflight } from './update/preflight';
import { detectNativeInstall } from './update/source';
import { maybeRelaunchWithStagedNativeUpdate } from './update/native-swap';
import { createKimiCodeHostIdentity, getVersion } from './version';

/**
 * Outcome of a CLI command run, reported back to the process entrypoint.
 *
 * `handleMainCommand` is a reusable, unit-tested handler — it must not terminate
 * the process itself. It reports here whether a headless (`kimi -p`) run
 * completed so the entrypoint (the only place that owns the process) can arm the
 * force-exit fallback.
 */
export interface MainCommandOutcome {
  readonly headlessCompleted: boolean;
}

export async function handleMainCommand(
  opts: CLIOptions,
  version: string,
): Promise<MainCommandOutcome> {
  let validated: ReturnType<typeof validateOptions>;
  startupTrace('main:enter');
  try {
    validated = validateOptions(opts);
  } catch (error) {
    if (error instanceof OptionConflictError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  startupTrace('preflight:begin');
  const preflightResult = await runUpdatePreflight(
    version,
    validated.uiMode === 'print' ? { track, isTTY: false } : { track },
  );
  startupTrace('preflight:end');
  if (preflightResult === 'exit') {
    process.exit(0);
  }

  if (validated.uiMode === 'print') {
    await runPrompt(validated.options, version);
    return { headlessCompleted: true };
  }

  startupTrace('runShell:begin');
  await runShell(validated.options, version);
  return { headlessCompleted: false };
}

/** `kimi migrate`: launch the migration screen only, then exit. `--run` runs the full migration headlessly with step logs instead. */
async function handleMigrateCommand(
  version: string,
  options: MigrateCommandOptions,
): Promise<void> {
  if (options.configOnly && !options.run) {
    process.stderr.write('error: --config-only requires --run\n');
    process.exitCode = 2;
    return;
  }
  if (options.run) {
    // Set the exit code and return normally — an immediate process.exit here
    // could terminate before buffered step/report output is flushed when the
    // command is piped or redirected.
    process.exitCode = await runHeadlessMigrate({ configOnly: options.configOnly });
    return;
  }
  await runShell(MIGRATE_CLI_OPTIONS, version, { migrateOnly: true });
}

export async function handleUpgradeCommand(version: string, yes: boolean): Promise<void> {
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
    exitCode = await handleUpgrade(version, { track, logger: log, yes });
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
  agent: undefined,
  agentFiles: [],
  runtime: undefined,
};

export function main(): void {
  process.title = PROCESS_NAME;
  installCrashHandlers();
  // A staged native update is swapped in and re-exec'd here, before any other
  // initialization, so the user session immediately runs the new binary (and
  // the old process never replaces itself while running). Every failure path
  // inside falls back to a normal startup with the current exe.
  void maybeRelaunchWithStagedNativeUpdate({
    exePath: process.execPath,
    argv: process.argv,
    env: process.env,
    currentVersion: getVersion(),
    isNative: detectNativeInstall(),
  })
    .catch(() => false)
    .then((relaunched) => {
      if (!relaunched) bootstrap();
    });
}

function bootstrap(): void {
  // Route all outbound fetch through HTTP_PROXY/HTTPS_PROXY (honoring NO_PROXY)
  // before any client is constructed. No-op when no proxy variable is set; an
  // invalid proxy URL is reported and ignored rather than aborting startup.
  installGlobalProxyDispatcher();
  installNativeModuleHook();
  // Best-effort SEA worker installation. Diagnostics are trace-only and avoid
  // exposing the user's cache path; failure keeps MiniDb's bounded inline mode.
  const workerInstall = installMinidbTextBuildWorker();
  startupTrace(
    workerInstall.status === 'installed'
      ? `minidb-worker:installed basename=${workerInstall.basename} sha256=${workerInstall.assetSha256}`
      : workerInstall.status === 'failed'
        ? `minidb-worker:failed code=${workerInstall.errorCode} sha256=${workerInstall.assetSha256 ?? 'unknown'}`
        : `minidb-worker:${workerInstall.status}`,
  );
  // Same pattern for the global-search worker: extracted from the SEA blob so
  // the search index runs off the main thread; a failure leaves the search
  // surface degraded ([database] search = false restores the inline host).
  const searchWorkerInstall = installKapSearchWorker();
  startupTrace(
    searchWorkerInstall.status === 'installed'
      ? `search-worker:installed basename=${searchWorkerInstall.basename} sha256=${searchWorkerInstall.assetSha256}`
      : searchWorkerInstall.status === 'failed'
        ? `search-worker:failed code=${searchWorkerInstall.errorCode} sha256=${searchWorkerInstall.assetSha256 ?? 'unknown'}`
        : `search-worker:${searchWorkerInstall.status}`,
  );
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
      void handleMainCommand(opts, version)
        .then(async (outcome) => {
          // Only the process entrypoint disposes of the process. Print mode
          // relies on the event loop draining to exit; flush any buffered output
          // and then arm an unref'd fallback so a stray ref'd handle left over
          // from the run can't wedge a completed `kimi -p` until an external
          // timeout. A healthy run drains and exits before the fallback fires.
          if (outcome.headlessCompleted) {
            await finalizeHeadlessRun(
              process,
              [process.stdout, process.stderr],
              () => Number(process.exitCode) || 0,
            );
          }
        })
        .catch(async (error: unknown) => {
          // Set the failure exit code synchronously, before any `await`. The
          // terminal `process.exit(1)` below is our intended exit, but it sits
          // behind `await logStartupFailure(...)`; by the time we reach that
          // await, the failed run's `finally` cleanup has already torn down its
          // ref'd handles (sockets, timers, background tasks). If the event loop
          // drains during the await, Node exits on its own with the DEFAULT code
          // 0 and `process.exit(1)` never runs — headless (`kimi -p`) failures
          // would then exit 0 nondeterministically. Setting `process.exitCode`
          // up front makes that drain-exit report failure too.
          process.exitCode = 1;
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
    (migrateOptions) => {
      void handleMigrateCommand(version, migrateOptions).catch(async (error: unknown) => {
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
    (yes) => {
      void handleUpgradeCommand(version, yes).catch(async (error: unknown) => {
        await logStartupFailure('upgrade', error);
        process.stderr.write(formatStartupError(error, { operation: 'upgrade' }));
        process.stderr.write(`See log: ${resolveGlobalLogPath(resolveKimiHome())}\n`);
        process.exit(1);
      });
    },
    (targetVersion, manual) => {
      void runUpdateDownloadCommand(targetVersion, manual).then(
        (code) => {
          process.exit(code);
        },
        async (error: unknown) => {
          await logStartupFailure('download update', error);
          process.exit(1);
        },
      );
    },
    (listen) => {
      // Reached only when the argv pre-dispatch in `src/main.ts` did not match
      // the exact light shape (e.g. `--listen=stdio` or a bad transport) — the
      // full CLI is already loaded, so correctness matters here, not startup
      // cost. stdout still carries protocol frames only.
      void runExecServerCommand(listen).then((code) => {
        process.exitCode = code;
      });
    },
  );

  program.parse(process.argv);
}

async function logStartupFailure(operation: string, error: unknown): Promise<void> {
  log.error('startup failed', { operation, error });
  try {
    await flushDiagnosticLogs();
  } catch {
    // Best-effort diagnostic flush only.
  }
}
