import { describe, expect, it, vi } from 'vitest';

import { clampIndex } from '#/tui/components/dialogs/review-reader';
import {
  ReviewReaderFullscreenApp,
  type ReviewReaderFullscreenProps,
} from '#/tui/components/dialogs/review-reader-fullscreen';
import type { ReviewArtifact } from '@moonshot-ai/kimi-code-sdk';

const ANSI_SGR = /\[[0-9;]*m/g;

describe('clampIndex', () => {
  it('keeps the index within [0, length)', () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-2, 3)).toBe(0);
    expect(clampIndex(1, 3)).toBe(1);
  });

  it('returns 0 for an empty list', () => {
    expect(clampIndex(4, 0)).toBe(0);
  });
});

function fullscreenArtifact(): ReviewArtifact {
  return {
    slug: 'topic-slug',
    target: { scope: 'working_tree' },
    diff: '',
    comments: [
      {
        id: 'c1',
        severity: 'critical',
        title: 'A bug',
        body: 'Details',
        anchor: { path: 'src/a.ts', side: 'new', line: 3, hunkHeader: '@@ -1,2 +1,2 @@' },
        state: 'candidate',
        dismissal: null,
      },
    ],
  } as unknown as ReviewArtifact;
}

function makeFullscreenReader(over: Partial<ReviewReaderFullscreenProps> = {}) {
  const requestRender = vi.fn();
  const onExport = vi.fn(async () => '/tmp/review-topic-slug.md');
  const app = new ReviewReaderFullscreenApp({
    artifact: fullscreenArtifact(),
    terminal: { rows: 40, columns: 120 } as never,
    onReject: async () => undefined,
    onRestore: async () => undefined,
    onClose: () => {},
    onExport,
    requestRender,
    ...over,
  });
  return { app, onExport, requestRender };
}

function footer(app: ReviewReaderFullscreenApp): string {
  return (app.render(120).at(-1) ?? '').replaceAll(ANSI_SGR, '');
}

describe('ReviewReaderFullscreenApp export', () => {
  it('shows the export hint in the footer when an exporter is wired', () => {
    const { app } = makeFullscreenReader();
    expect(footer(app)).toContain('e export');
  });

  it('omits the export hint when no exporter is wired', () => {
    const { app } = makeFullscreenReader({ onExport: undefined });
    expect(footer(app)).not.toContain('e export');
  });

  it('exports on "e" and flashes the written path', async () => {
    const { app, onExport } = makeFullscreenReader();
    app.handleInput('e');
    expect(onExport).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(footer(app)).toContain('Exported to /tmp/review-topic-slug.md');
    });
  });

  it('flashes a failure when export rejects', async () => {
    const onExport = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { app } = makeFullscreenReader({ onExport });
    app.handleInput('e');
    await vi.waitFor(() => {
      expect(footer(app)).toContain('Export failed.');
    });
  });
});
