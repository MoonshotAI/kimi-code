import { basename, dirname, extname, join } from 'node:path';

import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs';

import type { DownloadItem, Session } from 'electron';

export interface DownloadDeps {
  showSaveDialog: (opts: { defaultPath: string }) => string | undefined;
  downloadsDir: string;
}

const installedSessions = new WeakSet<object>();

export function installDownloadHandler(session: Session, deps: DownloadDeps): void {
  if (installedSessions.has(session)) return;
  installedSessions.add(session);

  let lastDir = deps.downloadsDir;

  session.on('will-download', (_event, item) => {
    const target = deps.showSaveDialog({ defaultPath: join(lastDir, item.getFilename()) });
    if (!target) {
      item.cancel();
      return;
    }
    item.setSavePath(target);
    lastDir = dirname(target);
  });
}

export function setAutomaticDownloadPath(item: DownloadItem, directory: string): void {
  const filename = basename(item.getFilename()) || 'download';
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  mkdirSync(directory, { recursive: true });
  let destination = join(directory, filename);
  let descriptor: number;
  for (let index = 1; ; index += 1) {
    try {
      descriptor = openSync(destination, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      destination = join(directory, `${stem} (${index})${extension}`);
    }
  }
  const reservation = fstatSync(descriptor);
  closeSync(descriptor);
  const release = (): void => {
    try {
      const current = lstatSync(destination);
      if (current.ino === reservation.ino && current.dev === reservation.dev && current.size === 0) unlinkSync(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  try {
    item.setSavePath(destination);
    item.once('done', (_event, state) => { if (state !== 'completed') release(); });
  } catch (error) {
    release();
    throw error;
  }
}
