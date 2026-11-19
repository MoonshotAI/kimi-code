
import {
  setKaTeXWorker,
  clearKaTeXWorker,
  setMermaidWorker,
  clearMermaidWorker,
} from 'markstream-vue';
import * as katexWorkerModule from 'markstream-vue/workers/katexRenderer.worker?worker&type=module';
import * as mermaidWorkerModule from 'markstream-vue/workers/mermaidParser.worker?worker&type=module';

let initialized = false;

export function ensureMarkdownWorkers(): void {
  if (initialized) return;
  if (typeof Worker === 'undefined') return;
  initialized = true;
  setKaTeXWorker(new katexWorkerModule.default());
  setMermaidWorker(new mermaidWorkerModule.default());
}

ensureMarkdownWorkers();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearKaTeXWorker();
    clearMermaidWorker();
  });
  import.meta.hot.accept();
}
