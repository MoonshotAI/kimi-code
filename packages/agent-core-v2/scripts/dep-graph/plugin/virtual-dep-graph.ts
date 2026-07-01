/**
 * Vite plugin — exposes `virtual:dep-graph` as a module whose default export
 * is the current analyzer output, and continuously mirrors the same output to
 * `.local/dep-graph.json` on disk while the dev server runs. On any change
 * under `src/**\/*.ts` we re-run the analyzer, rewrite the snapshot, and
 * invalidate the virtual module so the React Flow view refreshes via HMR.
 *
 * The plugin runs only in the dev server process; nothing about it ships
 * with the package (`dist/` is untouched — see `tsdown.config.ts`, which
 * only bundles `src/index.ts`).
 */

import { relative } from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';
import type { Plugin, ViteDevServer } from 'vite';

import {
  SNAPSHOT_PATH,
  SRC_ROOT,
  analyze,
  readHeadSha,
  summarize,
  writeSnapshot,
} from '../analyzer/analyze';
import type { Graph } from '../analyzer/types';

const VIRTUAL_ID = 'virtual:dep-graph';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/** Coalesce watcher bursts (single save often fires add+change+rename). */
const DEBOUNCE_MS = 200;

function tag(): string {
  return readHeadSha() ?? new Date().toISOString();
}

function isSrcFile(file: string): boolean {
  const rel = relative(SRC_ROOT, file);
  return !rel.startsWith('..') && (file.endsWith('.ts') || file.endsWith('.tsx'));
}

interface PluginOptions {
  /** If false, don't mirror the graph to disk (in-memory only). Default true. */
  writeSnapshotFile?: boolean;
}

export function depGraphPlugin(options: PluginOptions = {}): Plugin {
  const shouldWrite = options.writeSnapshotFile ?? true;
  let cached: Graph | undefined;
  let server: ViteDevServer | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;

  function analyzeNow(reason: string): void {
    const started = Date.now();
    cached = analyze({ generatedAt: tag() });
    if (shouldWrite) writeSnapshot(cached);
    const took = Date.now() - started;
    console.log(
      `[dep-graph] ${reason} → ${summarize(cached)}${
        shouldWrite ? ` (wrote ${relative(process.cwd(), SNAPSHOT_PATH)})` : ''
      } in ${took}ms`,
    );
  }

  function scheduleRefresh(reason: string): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      analyzeNow(reason);
      invalidate();
    }, DEBOUNCE_MS);
  }

  function invalidate(): void {
    if (!server) return;
    const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
    if (mod) {
      server.moduleGraph.invalidateModule(mod);
      server.ws.send({ type: 'full-reload', path: '*' });
    }
  }

  return {
    name: 'agent-core-v2:dep-graph',
    buildStart() {
      // Run once eagerly so the snapshot file exists as soon as the dev
      // server prints its "ready" banner — external tools (and the first
      // browser load) don't have to wait for the first save.
      if (!cached) analyzeNow('startup');
    },
    configureServer(dev) {
      server = dev;
      // Vite's own watcher is scoped to the project `root` (the `web/`
      // directory) and doesn't observe files under `src/`, so we spin up a
      // dedicated chokidar watcher pointed at the source tree. Debounced
      // above so a single save that fires multiple chokidar events only
      // triggers one re-analysis.
      //
      // We watch the directory (not a glob) because chokidar v4 dropped
      // built-in glob support — filtering to `.ts` happens in `isSrcFile`.
      watcher = chokidar.watch(SRC_ROOT, {
        ignoreInitial: true,
        ignored: (path, stats) => {
          if (!stats) return false;
          if (stats.isDirectory()) return false;
          return !path.endsWith('.ts');
        },
      });
      watcher.on('ready', () => {
        console.log(`[dep-graph] watching ${relative(process.cwd(), SRC_ROOT)}`);
      });
      for (const evt of ['add', 'change', 'unlink'] as const) {
        watcher.on(evt, (file: string) => {
          if (!isSrcFile(file)) return;
          scheduleRefresh(`${evt} ${relative(SRC_ROOT, file)}`);
        });
      }
    },
    async closeBundle() {
      if (debounceTimer) clearTimeout(debounceTimer);
      await watcher?.close();
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      if (!cached) analyzeNow('load');
      return `export default ${JSON.stringify(cached)};`;
    },
  };
}
