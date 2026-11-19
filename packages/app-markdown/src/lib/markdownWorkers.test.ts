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

vi.hoisted(() => {
  vi.stubGlobal('Worker', class {});
});

describe('ensureMarkdownWorkers', () => {
  it('registers the pair on module evaluation (before any explicit call)', () => {
    expect(vi.mocked(setKaTeXWorker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setMermaidWorker)).toHaveBeenCalledTimes(1);
  });

  it('creates the shared worker pair exactly once across repeated calls', () => {
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
