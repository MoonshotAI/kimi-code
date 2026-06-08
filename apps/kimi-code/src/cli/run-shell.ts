import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  setCrashPhase,
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';
import {
  createKimiHarness,
  log,
  type KimiHarness,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';

import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_UI_MODE } from '#/constant/app';
import { detectPendingMigration } from '#/migration/index';
import type { TuiConfig } from '#/tui/config';
import { loadTuiConfig, TuiConfigParseError } from '#/tui/config';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { KimiTUI } from '#/tui/index';
import { detectTerminalTheme } from '#/tui/theme/detect';

import type { CLIOptions } from './options';
import { createCliTelemetryBootstrap, initializeCliTelemetry } from './telemetry';
import { createKimiCodeHostIdentity } from './version';

export async function runShell(
  opts: CLIOptions,
  version: string,
  runOptions: { readonly migrateOnly?: boolean } = {},
): Promise<void> {
  const startedAt = Date.now();
  const configStartedAt = startedAt;
  let tuiConfig: TuiConfig;
  let configWarning: string | undefined;
  try {
    tuiConfig = await loadTuiConfig();
  } catch (error) {
    if (!(error instanceof TuiConfigParseError)) throw error;
    tuiConfig = error.fallback;
    configWarning = error.message;
  }

  // Resolve `theme = "auto"` against the live terminal once, before pi-tui
  // grabs stdin. Explicit `dark` / `light` skip detection.
  const resolvedTheme = tuiConfig.theme === 'auto' ? await detectTerminalTheme() : tuiConfig.theme;

  const workDir = process.cwd();
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
    onOAuthRefresh: (outcome) => {
      if (outcome.success) {
        track('oauth_refresh', { success: true });
        return;
      }
      track('oauth_refresh', {
        success: false,
        reason: outcome.reason,
      });
    },
  });
  log.info('kimi-code starting', {
    version,
    uiMode: CLI_UI_MODE,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    workDir,
  });

  await harness.ensureConfigFile();
  const migrationPlan = await detectPendingMigration({
    sourceHome: join(homedir(), '.kimi'),
    targetHome: harness.homeDir,
    ignoreMarker: runOptions.migrateOnly,
  });
  if (runOptions.migrateOnly === true && migrationPlan === null) {
    process.stdout.write('  Nothing to migrate from ~/.kimi/.\n');
    await harness.close();
    return;
  }
  const config = await harness.getConfig();
  const configMs = Date.now() - configStartedAt;
  const tui = new KimiTUI(harness, {
    cliOptions: opts,
    tuiConfig,
    version,
    workDir,
    startupNotice: configWarning,
    resolvedTheme,
    migrationPlan,
    migrateOnly: runOptions.migrateOnly,
  });

  initializeCliTelemetry({
    harness,
    bootstrap: telemetryBootstrap,
    config,
    version,
    uiMode: CLI_UI_MODE,
  });
  setCrashPhase('runtime');

  const resumed = opts.continue || opts.session !== undefined;
  const trackLifecycleForSession = (
    sessionId: string,
    event: string,
    properties?: Parameters<KimiHarness['track']>[1],
  ) => {
    if (sessionId.length === 0) {
      harness.track(event, properties);
      return;
    }
    withTelemetryContext({ sessionId }).track(event, properties);
  };
  const trackLifecycle = (event: string, properties?: Parameters<KimiHarness['track']>[1]) => {
    trackLifecycleForSession(tui.getCurrentSessionId(), event, properties);
  };

  tui.onExit = async (exitCode = 0) => {
    const sessionId = tui.getCurrentSessionId();
    const hasContent = tui.hasSessionContent();
    setCrashPhase('shutdown');
    trackLifecycle('exit', { duration_s: (Date.now() - startedAt) / 1000 });
    await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
    const gutter = ' '.repeat(CHROME_GUTTER);
    process.stdout.write(`${gutter}Bye!\n`);
    if (sessionId !== '' && hasContent) {
      process.stderr.write(`\n${gutter}To resume this session: kimi -r ${sessionId}\n`);
    }
    process.exit(exitCode);
  };
  try {
    execSync('stty -ixon', { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  try {
    const initStartedAt = Date.now();
    await tui.start();
    const initMs = Date.now() - initStartedAt;
    trackLifecycle('started', {
      resumed,
      yolo: opts.yolo,
      auto: opts.auto,
      plan: opts.plan,
      afk: false,
    });
    const startupSessionId = tui.getCurrentSessionId();
    const mcpMs = await tui.getStartupMcpMs();
    trackLifecycleForSession(startupSessionId, 'startup_perf', {
      duration_ms: Date.now() - startedAt,
      config_ms: configMs,
      init_ms: initMs,
      mcp_ms: mcpMs,
    });
  } catch (error) {
    setCrashPhase('shutdown');
    trackLifecycle('exit', { duration_s: (Date.now() - startedAt) / 1000 });
    await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
    await harness.close();
    throw error;
  }
}
