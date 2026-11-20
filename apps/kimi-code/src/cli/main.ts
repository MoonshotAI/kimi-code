import {
  createKimiHarness,
  ErrorCodes,
  flushDiagnosticLogs,
  installGlobalProxyDispatcher,
  isKimiError,
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
import { installNativeModuleHook } from '#/native/module-hook';
import { cleanupStaleNativeCacheForCurrent, getSqliteNativeBinding } from '#/native/native-assets';
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
import { runForcedUpgradePreflight } from './update/forced';
import { detectNativeInstall } from './update/source';
import { maybeRelaunchWithStagedNativeUpdate } from './update/native-swap';
import { createKimiCodeHostIdentity } from './host-identity';
import { getVersion } from './version';

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
  const updateOptions = validated.uiMode === 'print' ? { track, isTTY: false } : { track };
  const forcedResult = await runForcedUpgradePreflight(version, updateOptions);
  if (forcedResult === 'interrupt') {
    process.exit(130);
  }
  if (forcedResult === 'exit') {
    process.exit(0);
  }
  const preflightResult = forcedResult === 'skip-passive'
    ? 'continue'
    : await runUpdatePreflight(version, updateOptions);
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
  environment: undefined,
};

export function main(): void {
  process.title = PROCESS_NAME;
  installCrashHandlers();
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
  installGlobalProxyDispatcher();
  installNativeModuleHook();
  const sqliteNativeBinding = getSqliteNativeBinding();
  if (sqliteNativeBinding !== null) {
    process.env['KIMI_CODE_SQLITE_NATIVE_BINDING'] = sqliteNativeBinding;
  }
  if (runNativeAssetSmokeIfRequested()) return;

  queueMicrotask(() => {
    try {
      cleanupStaleNativeCacheForCurrent();
    } catch {}
  });

  const version = getVersion();

  const program = createProgram(
    version,
    (opts) => {
      void handleMainCommand(opts, version)
        .then(async (outcome) => {
          if (outcome.headlessCompleted) {
            await finalizeHeadlessRun(
              process,
              [process.stdout, process.stderr],
              () => Number(process.exitCode) || 0,
            );
          }
        })
        .catch(async (error: unknown) => {
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
    (targetVersion, manual, intent, channel) => {
      void runUpdateDownloadCommand(targetVersion, manual, intent, channel).then(
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
      void runExecServerCommand(listen).then((code) => {
        process.exitCode = code;
      });
    },
  );

  program.parse(process.argv);
}

async function logStartupFailure(operation: string, error: unknown): Promise<void> {
  log.error('startup failed', {
    operation,
    error,
    details:
      isKimiError(error) && error.code === ErrorCodes.WIRE_VERSION_TOO_LOW
        ? error.details
        : undefined,
  });
  try {
    await flushDiagnosticLogs();
  } catch {}
}
