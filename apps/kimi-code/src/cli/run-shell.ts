import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

import {
  createKimiHarness,
  flushDiagnosticLogsSync,
  log,
  type KimiHarness,
  type KimiHarnessOptions,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import {
  setCrashPhase,
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';

import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_UI_MODE, TUI_HOST_UI_CAPABILITIES } from '#/constant/app';
import { detectPendingMigration, resolveLegacySourceHome, sameLegacyPath } from '#/migration/index';
import type { TuiConfig } from '#/tui/config';
import { loadTuiConfig, resolveAnimationFrameRate, resolveTuiMode, TuiConfigParseError } from '#/tui/config';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { formatWorktreeExit } from '#/tui/controllers/worktree-exit';
import { KimiTUI } from '#/tui/index';
import { startupTrace } from '#/utils/startup-trace';
import { currentTheme, getColorPalette } from '#/tui/theme';
import { combineStartupNotice } from '#/tui/utils/startup';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import { restoreTerminalModes } from '#/utils/terminal-restore';
import { resolveCommandPath } from '#/utils/process/resolve-command';

import { worktreeFlagOffError, type CLIOptions } from './options';
import { resolveAgentProfileSelection } from './agent-selection';
import { resolveAdditionalDirs, resolveLaunchPaths } from './launch-paths';
import { createCliTelemetryBootstrap, initializeCliTelemetry } from './telemetry';
import { detectNativeInstall } from './update/source';
import { createKimiCodeHostIdentity } from './host-identity';

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

  const palette = await getColorPalette(tuiConfig.theme);
  currentTheme.setPalette(palette);

  const workDir = process.cwd();
  const telemetryBootstrap = createCliTelemetryBootstrap();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  let tui!: KimiTUI;
  const harnessOptions: KimiHarnessOptions = {
    homeDir: telemetryBootstrap.homeDir,
    identity: createKimiCodeHostIdentity(version),
    skillDirs: resolveLaunchPaths(opts, workDir).skillDirs,
    uiCapabilities: TUI_HOST_UI_CAPABILITIES,
    telemetry: telemetryClient,
    onOAuthRefresh: (outcome) => {
      if (outcome.success) {
        track('oauth_refresh', { outcome: 'success' });
        return;
      }
      track('oauth_refresh', {
        outcome: 'error',
        reason: outcome.reason,
      });
    },
    sshPassword: {
      prompt: (environmentId) => tui.promptSshPassword(environmentId),
      askpassCommand: detectNativeInstall()
        ? [process.execPath]
        : [process.execPath, ...process.execArgv, process.argv[1]!],
    },
    sessionStartedProperties: { yolo: opts.yolo, auto: opts.auto, plan: opts.plan, afk: false },
  };
  const harness = createKimiHarness(harnessOptions);
  startupTrace('harness:created');
  log.info('kimi-code starting', {
    version,
    uiMode: CLI_UI_MODE,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    workDir,
  });

  await harness.ensureConfigFile();
  const legacySource = resolveLegacySourceHome(process.env, homedir(), process.cwd());
  const sourceIsTarget = sameLegacyPath(legacySource.sourceHome, harness.homeDir);
  if (sourceIsTarget) {
    process.stderr.write(
      `  KIMI_SHARE_DIR (${legacySource.sourceHome}) points at the Kimi Code home; legacy migration is disabled. Unset it or point it at the kimi-cli data directory to migrate.\n`,
    );
  }
  const migrationPlan = sourceIsTarget
    ? null
    : await detectPendingMigration({
        sourceHome: legacySource.sourceHome,
        skillsSourceHome: legacySource.skillsSourceHome,
        targetHome: harness.homeDir,
        ignoreMarker: runOptions.migrateOnly,
      });
  if (runOptions.migrateOnly === true && migrationPlan === null) {
    if (!sourceIsTarget) {
      process.stdout.write(`  Nothing to migrate from ${legacySource.sourceHome}.\n`);
    }
    await harness.close();
    return;
  }
  const config = await harness.getConfig();
  startupTrace('config:loaded');
  if (
    opts.worktree !== undefined &&
    !(await harness.getExperimentalFeatures()).some((feature) => feature.id === 'worktree' && feature.enabled)
  ) {
    await harness.close();
    throw worktreeFlagOffError();
  }
  const workLocation = await harness.resolveWorkLocation(workDir);
  const configMs = Date.now() - configStartedAt;
  const agentProfile = await resolveAgentProfileSelection(opts, workDir);
  const tuiModeResolution = resolveTuiMode(tuiConfig.tuiMode);
  const animationFrameRateResolution = resolveAnimationFrameRate();
  tui = new KimiTUI(harness, {
    cliOptions: opts,
    agentProfile,
    additionalDirs:
      opts.worktree !== undefined
        ? resolveAdditionalDirs(opts.addDirs, workDir)
        : opts.addDirs?.length
          ? opts.addDirs
          : undefined,
    tuiConfig,
    resolvedTuiMode: tuiModeResolution.mode,
    animationFrameRate: animationFrameRateResolution.fps,
    version,
    workDir: workLocation.cwd,
    projectRoot: workLocation.projectRoot,
    isGitRepo: workLocation.isGitRepo,
    worktree: workLocation.worktree,
    startupNotice: combineStartupNotice(configWarning, animationFrameRateResolution.warning),
    migrationPlan,
    migrateOnly: runOptions.migrateOnly,
    telemetryDisabled: config.telemetry === false,
  });

  initializeCliTelemetry({
    harness,
    bootstrap: telemetryBootstrap,
    config,
    version,
    uiMode: CLI_UI_MODE,
  });
  setCrashPhase('runtime');

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

  let savedStty: string | undefined;
  const sttyPath = process.platform === 'win32' ? undefined : resolveCommandPath('stty');
  if (sttyPath !== undefined) {
    try {
      const saved = execFileSync(sttyPath, ['-g'], {
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'ignore'],
      });
      savedStty = saved.trim();
      execFileSync(sttyPath, ['-ixon'], { stdio: ['inherit', 'ignore', 'ignore'] });
    } catch {}
  }
  const restoreStty = (): void => {
    if (sttyPath === undefined || savedStty === undefined) return;
    const args = savedStty.split(/\s+/).filter((arg) => arg.length > 0);
    if (args.length === 0) return;
    spawnSync(sttyPath, args, { stdio: ['inherit', 'ignore', 'ignore'] });
  };

  const emergencyExit = (exitCode: number): void => {
    try {
      flushDiagnosticLogsSync();
    } catch {}
    restoreTerminalModes();
    restoreStty();
    process.exit(exitCode);
  };
  const onUncaughtException = (error: unknown): void => {
    try {
      log.error('uncaughtException, restoring terminal and exiting', { error: String(error) });
    } catch {}
    emergencyExit(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    try {
      log.error('unhandledRejection, restoring terminal and exiting', { reason: String(reason) });
    } catch {}
    emergencyExit(1);
  };
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  const removeCrashHandlers = (): void => {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
  };

  tui.onExit = async (exitCode = 0) => {
    const sessionId = tui.getCurrentSessionId();
    const hasContent = tui.hasSessionContent();
    setCrashPhase('shutdown');
    trackLifecycle('exit', {
      duration_ms: Date.now() - startedAt,
      tui_mode: tui.state.ui.mode,
      tui_mode_config: tuiModeResolution.config,
      tui_mode_fallback: tuiModeResolution.fallback,
    });
    try {
      await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
    } catch {}
    const gutter = ' '.repeat(CHROME_GUTTER);
    const worktreeExit = tui.worktreeExit.outcome;
    if (worktreeExit !== undefined) {
      process.stderr.write(formatWorktreeExit(worktreeExit).map((line) => `${gutter}${line}\n`).join(''));
    }
    if (tui.exitError === undefined) process.stdout.write(`${gutter}Bye!\n`);
    else process.stderr.write(`${tui.exitError}\n`);
    const hints: string[] = [];
    if (sessionId !== '' && hasContent) {
      hints.push(`${gutter}To resume this session: kimi -r ${sessionId}`);
    }
    if (tui.exitOpenUrl !== undefined) {
      hints.push(`${gutter}open ${toTerminalHyperlink(tui.exitOpenUrl, tui.exitOpenUrl)}`);
    }
    if (hints.length > 0) {
      process.stderr.write(`\n${hints.join('\n')}\n`);
    }
    removeCrashHandlers();
    restoreStty();
    if (tui.exitForegroundTask !== undefined) {
      await tui.exitForegroundTask(exitCode);
      return;
    }
    process.exit(exitCode);
  };
  try {
    const initStartedAt = Date.now();
    startupTrace('tui.start:begin');
    await tui.start();
    startupTrace('tui.start:end');
    const initMs = Date.now() - initStartedAt;
    const startupSessionId = tui.getCurrentSessionId();
    const mcpMs = await tui.getStartupMcpMs();
    trackLifecycleForSession(startupSessionId, 'startup_perf', {
      duration_ms: Date.now() - startedAt,
      config_ms: configMs,
      init_ms: initMs,
      mcp_ms: mcpMs,
      tui_mode: tui.state.ui.mode,
      tui_mode_config: tuiModeResolution.config,
      tui_mode_fallback: tuiModeResolution.fallback,
    });
  } catch (error) {
    removeCrashHandlers();
    setCrashPhase('shutdown');
    trackLifecycle('exit', {
      duration_ms: Date.now() - startedAt,
      tui_mode: tui.state.ui.mode,
      tui_mode_config: tuiModeResolution.config,
      tui_mode_fallback: tuiModeResolution.fallback,
    });
    try {
      await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
    } catch {}
    await harness.close();
    throw error;
  }
}
