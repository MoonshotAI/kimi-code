import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { app, crashReporter } from 'electron';

import { CRASH_DUMPS_DIR, addDiagnosticRoot, log, logsDir, tildify } from './log';
import { releaseChannelName } from '../release/release-channel';

export function startCrashReporter(): void {
  try {
    const root = logsDir();
    const channel = releaseChannelName(app.getVersion(), app.isPackaged);
    const dir = join(root, CRASH_DUMPS_DIR, channel);
    mkdirSync(dir, { recursive: true });
    app.setPath('crashDumps', dir);
    crashReporter.start({ uploadToServer: false, globalExtra: { channel } });
    addDiagnosticRoot(root);
    log.info(`[crash] reporter started (local only) dir=${tildify(dir)}`);
  } catch (error) {
    log.warn(`[crash] reporter unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
