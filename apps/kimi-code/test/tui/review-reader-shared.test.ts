import { describe, expect, it, vi } from 'vitest';

import { clampIndex } from '#/tui/components/dialogs/review-reader-shared';
import {
  ReviewReaderFullscreenApp,
  type ReviewReaderFullscreenProps,
} from '#/tui/components/dialogs/review-reader-fullscreen';
import type { ReviewArtifact } from '@moonshot-ai/kimi-code-sdk';

const ANSI_SGR = /\[[0-9;]*m/g;

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

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-old',
  '+new line',
  ' line3',
  '',
].join('\n');

function markdownArtifact(): ReviewArtifact {
  return {
    slug: 'topic-slug',
    target: { scope: 'working_tree' },
    diff: DIFF,
    comments: [
      {
        id: 'c1',
        severity: 'critical',
        title: 'A bug',
        body: 'This is **bold** and `code` text.',
        anchor: { path: 'src/a.ts', side: 'new', line: 2, hunkHeader: '@@ -1,3 +1,3 @@' },
        state: 'candidate',
        dismissal: null,
      },
    ],
  } as unknown as ReviewArtifact;
}

describe('ReviewReaderFullscreenApp markdown body', () => {
  it('renders the comment body as Markdown (no raw ** markers)', () => {
    const app = new ReviewReaderFullscreenApp({
      artifact: markdownArtifact(),
      terminal: { rows: 40, columns: 120 } as never,
      onReject: async () => undefined,
      onRestore: async () => undefined,
      onClose: () => {},
      requestRender: vi.fn(),
    });
    const body = app.render(120).map((line) => line.replaceAll(ANSI_SGR, '')).join('\n');
    expect(body).toContain('bold');
    expect(body).toContain('code');
    expect(body).not.toContain('**bold**');
  });

  it('puts the severity and title in a title bar with a rule below it', () => {
    const app = new ReviewReaderFullscreenApp({
      artifact: markdownArtifact(),
      terminal: { rows: 40, columns: 120 } as never,
      onReject: async () => undefined,
      onRestore: async () => undefined,
      onClose: () => {},
      requestRender: vi.fn(),
    });
    const text = app.render(120).map((line) => line.replaceAll(ANSI_SGR, '')).join('\n');
    // Title bar shows the severity tag and the title.
    expect(text).toContain('! critical');
    expect(text).toContain('A bug');
    // A title-bar rule (┠) separates the title from the body.
    expect(text).toContain('┠');
  });
});

function unsortedArtifact(): ReviewArtifact {
  const make = (
    severity: 'critical' | 'important' | 'minor',
    path: string,
    line: number,
    title: string,
  ) => ({
    id: `${path}:${String(line)}`,
    severity,
    title,
    body: '',
    anchor: { path, side: 'new', line, hunkHeader: '@@' },
    state: 'candidate',
    dismissal: null,
  });
  return {
    slug: 'topic-slug',
    target: { scope: 'working_tree' },
    diff: '',
    comments: [
      make('minor', 'src/b.ts', 5, 'minor-b5'),
      make('critical', 'src/b.ts', 9, 'crit-b9'),
      make('critical', 'src/a.ts', 30, 'crit-a30'),
      make('critical', 'src/a.ts', 2, 'crit-a2'),
      make('important', 'src/a.ts', 1, 'imp-a1'),
    ],
  } as unknown as ReviewArtifact;
}

describe('ReviewReaderFullscreenApp comment list', () => {
  function listArtifact(): ReviewArtifact {
    const make = (
      severity: 'critical' | 'important' | 'minor',
      line: number,
      title: string,
      state: 'candidate' | 'dismissed',
    ) => ({
      id: `c${String(line)}`,
      severity,
      title,
      body: '',
      anchor: { path: 'src/auth.ts', side: 'new', line, hunkHeader: '@@' },
      state,
      dismissal: state === 'dismissed' ? { reason: 'rejected_by_user' } : null,
    });
    return {
      slug: 'topic-slug',
      target: { scope: 'working_tree' },
      diff: '',
      comments: [
        make('critical', 88, 'Token refresh races on concurrent logins', 'candidate'),
        make('minor', 7, 'Redundant clone', 'dismissed'),
      ],
    } as unknown as ReviewArtifact;
  }

  function listLines(): string[] {
    const app = new ReviewReaderFullscreenApp({
      artifact: listArtifact(),
      terminal: { rows: 40, columns: 120 } as never,
      onReject: async () => undefined,
      onRestore: async () => undefined,
      onClose: () => {},
      requestRender: vi.fn(),
    });
    return app.render(120).map((line) => line.replaceAll(ANSI_SGR, ''));
  }

  it('puts the selection caret on the first title line, not the severity line', () => {
    const out = listLines();
    const severityLine = out.find((line) => line.includes('! critical'));
    const titleLine = out.find((line) => line.includes('❯') && line.includes('Token refresh races'));
    expect(severityLine).toBeDefined();
    expect(severityLine).not.toContain('❯'); // caret is not on the severity line
    expect(titleLine).toBeDefined();
  });

  it('shows the path on its own line', () => {
    expect(listLines().some((line) => line.includes('src/auth.ts:88'))).toBe(true);
  });

  it('keeps the severity color and right-aligns the reject status', () => {
    const out = listLines();
    const sevLine = out.find((line) => line.includes('· minor'));
    expect(sevLine).toBeDefined();
    // The reject status shares the severity line, to the right of the severity.
    expect(sevLine).toContain('rejected');
    expect(sevLine!.indexOf('· minor')).toBeLessThan(sevLine!.indexOf('rejected'));
  });
});

describe('ReviewReaderFullscreenApp comment order', () => {
  it('sorts comments by severity, then file, then line', () => {
    const app = new ReviewReaderFullscreenApp({
      artifact: unsortedArtifact(),
      terminal: { rows: 60, columns: 120 } as never,
      onReject: async () => undefined,
      onRestore: async () => undefined,
      onClose: () => {},
      requestRender: vi.fn(),
    });
    const text = app.render(120).map((line) => line.replaceAll(ANSI_SGR, '')).join('\n');
    const order = ['crit-a2', 'crit-a30', 'crit-b9', 'imp-a1', 'minor-b5'];
    const positions = order.map((title) => text.indexOf(title));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  });
});

describe('ReviewReaderFullscreenApp status line', () => {
  it('keeps the full hint with all key labels', () => {
    const app = new ReviewReaderFullscreenApp({
      artifact: markdownArtifact(),
      terminal: { rows: 40, columns: 120 } as never,
      onReject: async () => undefined,
      onRestore: async () => undefined,
      onClose: () => {},
      requestRender: vi.fn(),
    });
    const footer = (app.render(120).at(-1) ?? '').replaceAll(ANSI_SGR, '');
    for (const label of ['comment', 'scroll', 'y keep', 'n reject', 'q close']) {
      expect(footer).toContain(label);
    }
  });
});
