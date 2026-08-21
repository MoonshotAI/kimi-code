// ---------------------------------------------------------------------------
// Off-main-thread workers for KaTeX and Mermaid — ONE process-wide pair.
//
// Both katex.renderToString and mermaid.parse are CPU-heavy. markstream-vue
// ships pre-built workers (katexRenderer.worker.js, mermaidParser.worker.js)
// that follow the exact protocol its internal worker clients expect. We import
// them via Vite's `?worker&type=module` so they're built as ES module chunks
// (supporting code-splitting, which mermaid needs for per-diagram dynamic
// imports).
//
// markstream-vue's MermaidBlockNode and MathBlockNode auto-detect the presence
// of a worker: when set, heavy parsing/rendering is dispatched off-thread; when
// absent, everything runs on the main thread.
//
// This pair is created exactly once per renderer, here at module scope. It used
// to live in Markdown.vue's <script setup>, which runs per component instance:
// every mounted message terminated the shared workers (clearKaTeXWorker rejects
// all in-flight renders) and built a fresh pair — mounting N messages churned
// N worker pairs and aborted the KaTeX/Mermaid renders still running for the
// other N−1. ensureMarkdownWorkers() is the once-guard Markdown.vue calls; the
// workers then live for the app's lifetime and are never torn down.
// ---------------------------------------------------------------------------

import {
  setKaTeXWorker,
  clearKaTeXWorker,
  setMermaidWorker,
  clearMermaidWorker,
} from 'markstream-vue';
import * as katexWorkerModule from 'markstream-vue/workers/katexRenderer.worker?worker&type=module';
import * as mermaidWorkerModule from 'markstream-vue/workers/mermaidParser.worker?worker&type=module';

let initialized = false;

/** Create and register the shared KaTeX/Mermaid worker pair. Idempotent. */
export function ensureMarkdownWorkers(): void {
  if (initialized) return;
  // Non-DOM contexts (SSR, node test runners) have no Worker at all — skip
  // instead of crashing the import; markstream falls back to the main thread.
  if (typeof Worker === 'undefined') return;
  initialized = true;
  setKaTeXWorker(new katexWorkerModule.default());
  setMermaidWorker(new mermaidWorkerModule.default());
}

// Initialize at module evaluation, not only from Markdown.vue's setup: after
// an HMR self-accept (below) the module re-evaluates while every mounted
// Markdown stays put — without this line they would lose off-thread rendering
// (and any in-flight render) until the next fresh mount.
ensureMarkdownWorkers();

// HMR: editing this module makes Vite re-evaluate it (a fresh `initialized`),
// which would build a second worker pair. Terminate the superseded pair on
// invalidation so a dev session doesn't leak one pair per reload. Self-accept:
// mounted Markdown components keep rendering against the freshly created pair.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearKaTeXWorker();
    clearMermaidWorker();
  });
  import.meta.hot.accept();
}
