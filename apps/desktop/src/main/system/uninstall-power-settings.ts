import { app } from 'electron';
import { setLidSleepPreventionEnabled } from './prevent-lid-sleep';

export async function restorePowerSettingsForUninstall(): Promise<void> {
  try {
    if (process.platform !== 'win32' || !app.requestSingleInstanceLock()) {
      app.exit(1);
      return;
    }
    await app.whenReady();
    await setLidSleepPreventionEnabled(false);
    app.exit(0);
  } catch {
    app.exit(1);
  }
}
