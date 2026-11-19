import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { app, contentTracing, dialog } from 'electron';

import { getMainWindow, showMainWindow } from '../window/main-window';

const TRACE_CATEGORIES = [
  'blink',
  'v8',
  'toplevel',
  'ipc',
  'loading',
  'navigation',
  'renderer_host',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-blink.main_frame',
].join(',');

export type TraceToggleResult =
  | { status: 'started' }
  | { status: 'saved'; path: string }
  | { status: 'discarded' }
  | { status: 'busy' }
  | { status: 'error'; message: string; keptAt?: string };

export interface TraceRecorderDeps {
  startRecording: (categoryFilter: string) => Promise<void>;
  stopRecording: () => Promise<string>;
  showSaveDialog: (defaultPath: string) => Promise<string | undefined>;
  moveFile: (from: string, to: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  downloadsDir: () => string;
}

export function traceFileName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `kimi-code-trace-${stamp}.pftrace`;
}

export interface TraceRecorder {
  isRecording: () => boolean;
  toggle: () => Promise<TraceToggleResult>;
}

export function createTraceRecorder(deps: TraceRecorderDeps): TraceRecorder {
  let recording = false;
  let busy = false;
  return {
    isRecording: () => recording,
    async toggle() {
      if (busy) return { status: 'busy' };
      busy = true;
      try {
        if (!recording) {
          try {
            await deps.startRecording(TRACE_CATEGORIES);
          } catch (error) {
            return { status: 'error', message: String(error) };
          }
          recording = true;
          return { status: 'started' };
        }
        recording = false;
        try {
          const tempPath = await deps.stopRecording();
          try {
            const target = await deps.showSaveDialog(join(deps.downloadsDir(), traceFileName()));
            if (target === undefined) {
              await deps.removeFile(tempPath);
              return { status: 'discarded' };
            }
            await deps.moveFile(tempPath, target);
            return { status: 'saved', path: target };
          } catch (error) {
            return { status: 'error', message: String(error), keptAt: tempPath };
          }
        } catch (error) {
          return { status: 'error', message: String(error) };
        }
      } finally {
        busy = false;
      }
    },
  };
}

let singleton: TraceRecorder | null = null;

export function getTraceRecorder(): TraceRecorder {
  if (singleton === null) {
    singleton = createTraceRecorder({
      startRecording: (categoryFilter) =>
        contentTracing.startRecording({ categoryFilter, traceOptions: 'record-continuously' }),
      stopRecording: () => contentTracing.stopRecording(),
      showSaveDialog: async (defaultPath) => {
        showMainWindow();
        const win = getMainWindow();
        const result =
          win === null || win.isDestroyed()
            ? await dialog.showSaveDialog({ defaultPath })
            : await dialog.showSaveDialog(win, { defaultPath });
        return result.canceled ? undefined : result.filePath;
      },
      moveFile: async (from, to) => {
        await copyFile(from, to);
        await rm(from).catch(() => {});
      },
      removeFile: (path) => rm(path),
      downloadsDir: () => app.getPath('downloads'),
    });
  }
  return singleton;
}
