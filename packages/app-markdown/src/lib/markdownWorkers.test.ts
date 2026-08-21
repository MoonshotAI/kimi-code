// ensureMarkdownWorkers once-guard: Markdown.vue calls it from every
// instance's <script setup>. The shared KaTeX/Mermaid worker pair must be
// created exactly once and NEVER torn down per mount — markstream-vue's
// clear*Worker terminates the worker and rejects every in-flight render,
// including those of all other still-mounted messages.
import { describe, expect, it, vi } from 'vitest';
import {
  setKaTeXWorker,
  clearKaTeXWorker,
  setMermaidWorker,
  clearMermaidWorker,
} from 'markstream-vue';
import { ensureMarkdownWorkers } from './markdownWorkers';

vi.mock('markstream-vue', () => ({
  setKaTeXWorker: vi.fn(),
  clearKaTeXWorker: vi.fn(),
  setMermaidWorker: vi.fn(),
  clearMermaidWorker: vi.fn(),
}));
vi.mock('markstream-vue/workers/katexRenderer.worker?worker&type=module', () => ({
  default: class FakeKatexWorker {},
}));
vi.mock('markstream-vue/workers/mermaidParser.worker?worker&type=module', () => ({
  default: class FakeMermaidWorker {},
}));

// The guard skips initialization where no Worker global exists (SSR/node);
// the browser path under test has one. vi.hoisted installs it BEFORE the
// static imports run — the module-level initialization happens at import time.
vi.hoisted(() => {
  vi.stubGlobal('Worker', class {});
});

describe('ensureMarkdownWorkers', () => {
  it('registers the pair on module evaluation (before any explicit call)', () => {
    // No ensureMarkdownWorkers() call in this test body: the import at the
    // top of this file already ran the module-level initialization — the same
    // code path an HMR re-evaluation takes to recreate the disposed pair.
    expect(vi.mocked(setKaTeXWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setMermaidWorker)).toHaveBeenCalledTimes(1);
  });

  it('creates the shared worker pair exactly once across repeated calls', () => {
    // Repeated calls stand in for mounting many Markdown instances (each
    // <script setup> invocation calls the guard once).
    ensureMarkdownWorkers();
    ensureMarkdownWorkers();
    ensureMarkdownWorkers();

    expect(vi.mocked(setKaTeXWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setMermaidWorker)).toHaveBeenCalledTimes(1);
  });

  it('passes a worker instance to each registrar', () => {
    ensureMarkdownWorkers();

    expect(vi.mocked(setKaTeXWorker).mock.calls[0]?.[0]).toBeDefined();
    expect(vi.mocked(setMermaidWorker).mock.calls[0]?.[0]).toBeDefined();
  });

  it('never tears the pair down on (re)mount', () => {
    ensureMarkdownWorkers();

    expect(vi.mocked(clearKaTeXWorker)).not.toHaveBeenCalled();
    expect(vi.mocked(clearMermaidWorker)).not.toHaveBeenCalled();
  });
});
