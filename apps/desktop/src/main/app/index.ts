import { app } from 'electron';

import { startCrashReporter } from '../diagnostics/crash-reporter';
import { initMainLogging, log, logLaunchBanner } from '../diagnostics/log';
import { e2eWindowMode } from './e2e-mode';
import { registerAppSchemes } from './protocol';
import { startShellEnvProbe } from '../system/shell-env';
import { isCanaryVersion, isPreviewVersion } from '../release/release-channel';
import { consumePendingStableImport } from '../release/stable-settings-import';
import { applyRuntimeEnvironmentOverrides } from './runtime-environment';

if (isCanaryVersion(app.getVersion())) {
  app.setName('Kimi Code Canary');
} else if (isPreviewVersion(app.getVersion())) {
  app.setName('Kimi Code Preview');
}

if (e2eWindowMode() === 'quiet' && process.platform === 'darwin') app.setActivationPolicy('prohibited');

if (process.platform === 'win32' && process.argv.includes('--restore-lid-sleep-on-uninstall')) {
  void import('../system/uninstall-power-settings')
    .then(({ restorePowerSettingsForUninstall }) => restorePowerSettingsForUninstall())
    .catch(() => app.exit(1));
} else {
  applyRuntimeEnvironmentOverrides();
  initMainLogging();
  logLaunchBanner();
  startCrashReporter();
  if (isCanaryVersion(app.getVersion())) {
    try {
      consumePendingStableImport(app.getPath('userData'), log);
    } catch (error) {
      log.warn(`[kimi-desktop] stable UI-settings import errored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  registerAppSchemes();

  void startShellEnvProbe();

  app.commandLine.appendSwitch(
    'enable-features',
    [
      'DocumentPolicyIncludeJSCallStacksInCrashReports',
      ...(process.platform === 'linux' ? ['GlobalShortcutsPortal'] : []),
    ].join(','),
  );

  if (process.argv.includes('--screenshot-diagnostics')) {
    void import('../screenshot/screenshot-diagnostics').then(({ runScreenshotDiagnostics }) => runScreenshotDiagnostics());
  } else {
    void import('./lifecycle').then(({ main }) => main());
  }
}
