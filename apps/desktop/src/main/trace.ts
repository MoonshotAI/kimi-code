import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { app, contentTracing, dialog } from 'electron';

import { getMainWindow, showMainWindow } from './window';

// Help-menu performance trace, built on contentTracing: Chromium trace events
// across the browser/renderer/GPU processes, written as one JSON file the
// user can open in ui.perfetto.dev or chrome://tracing. The category set
// targets jank diagnosis (long tasks, style/layout/paint, IPC, V8 sampling);
// `record-continuously` keeps a ring buffer, so long sessions drop the
// earliest events.
//
// createTraceRecorder takes deps for tests; the module-level singleton wires
// the real Electron APIs (contentTracing needs app-ready, hence lazy init).

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
  /** Stops and resolves the temp file the trace landed in. */
  stopRecording: () => Promise<string>;
  /** Native save dialog; resolves the chosen absolute path, undefined on cancel. */
  showSaveDialog: (defaultPath: string) => Promise<string | undefined>;
  moveFile: (from: string, to: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  downloadsDir: () => string;
}

export function traceFileName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `kimi-code-trace-${stamp}.json`;
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
      // contentTracing is global process state: one start/stop in flight at a
      // time, or a double-click stacks concurrent calls on the same trace.
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
        // Flip the state BEFORE the stop/save flow so a re-entrant click can't
        // stack a second stopRecording on the same trace.
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
            // Keep the temp trace: it is the only copy of a possibly
            // hard-to-reproduce session. The menu layer localizes the
            // "kept at" notice from keptAt.
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
        // Parent the dialog to a visible window (macOS hide-on-close may
        // leave it hidden, and a sheet on a hidden window never appears).
        showMainWindow();
        const win = getMainWindow();
        const result =
          win === null || win.isDestroyed()
            ? await dialog.showSaveDialog({ defaultPath })
            : await dialog.showSaveDialog(win, { defaultPath });
        return result.canceled ? undefined : result.filePath;
      },
      // copy+rm instead of rename: the temp file and the user's chosen
      // directory may sit on different volumes (EXDEV). The rm is
      // best-effort — the copy already succeeded, so a leftover temp file
      // must not fail the save.
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
