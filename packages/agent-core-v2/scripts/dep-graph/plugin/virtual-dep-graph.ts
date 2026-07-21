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

const DEBOUNCE_MS = 200;

function tag(): string {
  return readHeadSha() ?? new Date().toISOString();
}

function isSrcFile(file: string): boolean {
  const rel = relative(SRC_ROOT, file);
  return !rel.startsWith('..') && (file.endsWith('.ts') || file.endsWith('.tsx'));
}

interface PluginOptions {
  writeSnapshotFile?: boolean;
}

function fingerprint(g: Graph): string {
  return JSON.stringify({
    services: g.services,
    edges: g.edges,
    unknownTokens: g.unknownTokens,
  });
}

export function depGraphPlugin(options: PluginOptions = {}): Plugin {
  const shouldWrite = options.writeSnapshotFile ?? true;
  let cached: Graph | undefined;
  let cachedFingerprint: string | undefined;
  let server: ViteDevServer | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;

  function analyzeNow(reason: string): boolean {
    const started = Date.now();
    const next = analyze({ generatedAt: tag() });
    const nextFingerprint = fingerprint(next);
    const changed = nextFingerprint !== cachedFingerprint;
    if (changed) {
      cached = next;
      cachedFingerprint = nextFingerprint;
      if (shouldWrite) writeSnapshot(next);
    }
    const took = Date.now() - started;
    const suffix = changed
      ? shouldWrite
        ? ` (wrote ${relative(process.cwd(), SNAPSHOT_PATH)})`
        : ''
      : ' (no change)';
    console.log(`[dep-graph] ${reason} → ${summarize(next)}${suffix} in ${took}ms`);
    return changed;
  }

  function scheduleRefresh(reason: string): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      if (analyzeNow(reason)) invalidate();
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
      if (!cached) analyzeNow('startup');
    },
    configureServer(dev) {
      server = dev;
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
