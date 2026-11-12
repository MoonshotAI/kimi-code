import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';

import {
  ACTIVITY_LOG,
  COMMS_DIR,
  LOG_DIR,
  STATE_FILE,
  TOWER_ROOT,
} from '#/features/tower/protocol/paths';

export interface TowerWatchHint {
  readonly stateChanged: boolean;
  readonly logAppended: boolean;
}

const DEFAULT_DEBOUNCE_MS = 300;
const REARM_DELAY_MS = 50;

export function watchTower(
  repoRoot: string,
  onChange: (hint: TowerWatchHint) => void,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): () => void {
  const commsDir = join(repoRoot, COMMS_DIR);
  const logDir = join(repoRoot, LOG_DIR);
  const towerDir = join(repoRoot, TOWER_ROOT);
  const commsName = basename(COMMS_DIR);
  const logName = basename(LOG_DIR);
  const stateFile = basename(STATE_FILE);
  const logFile = basename(ACTIVITY_LOG);

  let disposed = false;
  let pending: TowerWatchHint | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let rearmTimer: NodeJS.Timeout | undefined;
  const watchers = new Set<FSWatcher>();

  const flush = (): void => {
    debounceTimer = undefined;
    if (disposed || pending === undefined) return;
    const hint = pending;
    pending = undefined;
    onChange(hint);
  };

  const emit = (hint: TowerWatchHint): void => {
    if (disposed) return;
    pending = {
      stateChanged: (pending?.stateChanged ?? false) || hint.stateChanged,
      logAppended: (pending?.logAppended ?? false) || hint.logAppended,
    };
    if (debounceTimer !== undefined) return;
    debounceTimer = setTimeout(flush, debounceMs);
    debounceTimer.unref?.();
  };

  const clearRearm = (): void => {
    if (rearmTimer === undefined) return;
    clearTimeout(rearmTimer);
    rearmTimer = undefined;
  };

  const closeWatcher = (watcher: FSWatcher): void => {
    watchers.delete(watcher);
    try {
      watcher.close();
    } catch {}
  };

  const scheduleRearm = (): void => {
    if (disposed || rearmTimer !== undefined) return;
    rearmTimer = setTimeout(() => {
      rearmTimer = undefined;
      arm();
      emit({ stateChanged: true, logAppended: true });
    }, REARM_DELAY_MS);
    rearmTimer.unref?.();
  };

  const armDir = (dir: string, expectedFile: string | undefined, onMatch: () => void): void => {
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, { persistent: true }, (_event, filename) => {
        if (disposed) return;
        if (
          expectedFile !== undefined &&
          filename !== null &&
          filename.toString() !== expectedFile
        ) {
          return;
        }
        if (!existsSync(dir)) {
          scheduleRearm();
          return;
        }
        onMatch();
      });
    } catch {
      scheduleRearm();
      return;
    }
    watchers.add(watcher);
    watcher.on('error', () => {
      closeWatcher(watcher);
      scheduleRearm();
    });
  };

  const arm = (): void => {
    if (disposed) return;
    clearRearm();
    for (const watcher of watchers) closeWatcher(watcher);
    if (existsSync(commsDir) && existsSync(logDir)) {
      armDir(commsDir, stateFile, () => emit({ stateChanged: true, logAppended: false }));
      armDir(logDir, logFile, () => emit({ stateChanged: false, logAppended: true }));
      return;
    }
    if (!existsSync(commsDir)) {
      const towerExists = existsSync(towerDir);
      armDir(
        towerExists ? towerDir : repoRoot,
        towerExists ? commsName : basename(TOWER_ROOT),
        scheduleRearm,
      );
      return;
    }
    armDir(commsDir, logName, scheduleRearm);
  };

  arm();

  return () => {
    if (disposed) return;
    disposed = true;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = undefined;
    clearRearm();
    for (const watcher of watchers) closeWatcher(watcher);
    pending = undefined;
  };
}
