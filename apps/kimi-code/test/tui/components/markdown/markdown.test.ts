import { Markdown as PiMarkdown, visibleWidth, type TuiMouseEvent } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { render as renderMermaidSource } from 'lovely-mermaid';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from '#/tui/components/markdown/markdown';
import { darkColors, lightColors } from '#/tui/theme/colors';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { currentTheme } from '#/tui/theme/theme';
import {
  setMarkdownAltScreenActive,
  setMarkdownMermaidMode,
  setMarkdownRenderRequester,
} from '#/tui/utils/markdown-options';

chalk.level = 3;

const lovelyMock = vi.hoisted(() => ({
  renderBehavior: undefined as undefined | (() => unknown),
}));

vi.mock('lovely-mermaid', async () => {
  const actual = await vi.importActual<typeof import('lovely-mermaid')>('lovely-mermaid');
  return {
    ...actual,
    render: (source: string) =>
      lovelyMock.renderBehavior === undefined ? actual.render(source) : lovelyMock.renderBehavior(),
  };
});

const clipboardMock = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn<(text: string) => Promise<'native' | 'osc52'>>(),
}));

vi.mock('#/utils/clipboard/clipboard-text', () => clipboardMock);

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function renderText(markdown: Markdown, width: number): string {
  return markdown.render(width).map(strip).join('\n');
}

function mouseEvent(
  type: TuiMouseEvent['type'],
  x: number,
  y: number,
  width: number,
  height: number,
): TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

const SIMPLE_FLOWCHART = 'flowchart LR\n  A-->B\n  B-->C\n';

function mermaidDoc(body: string, fence = '```'): string {
  return `Intro paragraph.\n\n${fence}mermaid\n${body}${fence}\n\nOutro paragraph.\n`;
}

function fenceOnly(body: string, info = 'mermaid'): string {
  return `\`\`\`${info}\n${body}\`\`\`\n`;
}

afterEach(() => {
  setMarkdownMermaidMode('final');
  setMarkdownAltScreenActive(false);
  setMarkdownRenderRequester(() => {});
  currentTheme.setPalette(darkColors);
  lovelyMock.renderBehavior = undefined;
  clipboardMock.copyTextToClipboard.mockReset();
});

describe('Markdown mermaid rendering', () => {
  it('renders byte-identical output to pi-tui Markdown when the mode is off', () => {
    setMarkdownMermaidMode('off');
    const source = mermaidDoc(SIMPLE_FLOWCHART);
    const wrapped = new Markdown(source, 0, 0, createMarkdownTheme());
    const plain = new PiMarkdown(source, 0, 0, createMarkdownTheme());

    expect(wrapped.render(80)).toEqual(plain.render(80));
  });

  it('draws a top-level mermaid fence as box art once the reply is final', () => {
    const markdown = new Markdown(mermaidDoc(SIMPLE_FLOWCHART), 0, 0, createMarkdownTheme());
    const text = renderText(markdown, 80);

    expect(text).toContain('─');
    expect(text).toContain('│');
    expect(text).not.toContain('```mermaid');
    expect(text).toContain('Intro paragraph.');
    expect(text).toContain('Outro paragraph.');
  });

  it('keeps the fence as a plain code block while the theme is transient', () => {
    const markdown = new Markdown(
      mermaidDoc(SIMPLE_FLOWCHART),
      0,
      0,
      createMarkdownTheme({ transient: true }),
    );
    const text = renderText(markdown, 80);

    expect(text).toContain('```mermaid');
    expect(text).not.toContain('─');
  });

  it('draws tilde fences like backtick fences', () => {
    const markdown = new Markdown(mermaidDoc(SIMPLE_FLOWCHART, '~~~'), 0, 0, createMarkdownTheme());
    const text = renderText(markdown, 80);

    expect(text).toContain('─');
    expect(text).not.toContain('~~~mermaid');
  });

  it('treats the info string first token case-insensitively and ignores extra info', () => {
    for (const info of ['MERMAID', 'mermaid title="x"']) {
      const markdown = new Markdown(fenceOnly(SIMPLE_FLOWCHART, info), 0, 0, createMarkdownTheme());
      expect(renderText(markdown, 80)).toContain('─');
    }
  });

  it('leaves mermaid-js and other languages as plain code blocks', () => {
    const markdown = new Markdown(
      `${fenceOnly(SIMPLE_FLOWCHART, 'mermaid-js')}\n${fenceOnly('const x = 1;\n', 'ts')}`,
      0,
      0,
      createMarkdownTheme(),
    );
    const text = renderText(markdown, 80);

    expect(text).toContain('```mermaid-js');
    expect(text).toContain('```ts');
    expect(text).not.toContain('is not drawn in the terminal');
    expect(text).not.toContain('─');
  });

  it('leaves fences nested in quotes and lists as plain code blocks', () => {
    const quoted = '> ```mermaid\n> flowchart LR\n> A-->B\n> ```\n';
    const listed = '- item\n\n  ```mermaid\n  flowchart LR\n  A-->B\n  ```\n';
    for (const source of [quoted, listed]) {
      const markdown = new Markdown(source, 0, 0, createMarkdownTheme());
      const text = renderText(markdown, 80);

      expect(text).not.toContain('is not drawn in the terminal');
      expect(text).not.toContain('─');
    }
  });

  it('keeps the blank separator when a fence abuts prose without blank lines', () => {
    const source = 'Intro.\n```mermaid\nflowchart LR\n  A-->B\n```\nOutro.\n';
    const markdown = new Markdown(source, 0, 0, createMarkdownTheme());
    const lines = markdown.render(80).map((line) => strip(line).trimEnd());

    const introIndex = lines.findIndex((line) => line === 'Intro.');
    expect(lines[introIndex + 1]).toBe('');
    const outroIndex = lines.findIndex((line) => line === 'Outro.');
    expect(lines[outroIndex - 1]).toBe('');
    expect(lines.some((line) => line.includes('─'))).toBe(true);
  });
});

describe('Markdown mermaid fallback', () => {
  it('reports gantt as not drawn in the terminal and keeps the source fence', () => {
    const markdown = new Markdown(
      fenceOnly('gantt\n  title Plan\n  Task :2026-01-01, 3d\n'),
      0,
      0,
      createMarkdownTheme(),
    );
    const text = renderText(markdown, 100);

    expect(text).toContain('gantt diagrams are not drawn in the terminal');
    expect(text).toContain('```mermaid');
  });

  it('reports an empty supported diagram as could not draw, not as an unsupported kind', () => {
    const markdown = new Markdown(fenceOnly('flowchart LR\n'), 0, 0, createMarkdownTheme());
    const text = renderText(markdown, 100);

    expect(text).toContain('could not draw this mermaid diagram');
    expect(text).not.toContain('flowchart diagrams are not drawn');
  });

  it('reports an empty fence as could not draw this diagram', () => {
    const markdown = new Markdown(fenceOnly(''), 0, 0, createMarkdownTheme());
    const text = renderText(markdown, 100);

    expect(text).toContain('could not draw this mermaid diagram');
    expect(text).toContain('```mermaid');
  });

  it('reports a library throw as could not draw this diagram', () => {
    lovelyMock.renderBehavior = () => {
      throw new Error('boom');
    };
    const markdown = new Markdown(fenceOnly(SIMPLE_FLOWCHART), 0, 0, createMarkdownTheme());
    const text = renderText(markdown, 100);

    expect(text).toContain('could not draw this mermaid diagram');
    expect(text).toContain('```mermaid');
  });

  it('still draws when the library reports advisory warnings', () => {
    lovelyMock.renderBehavior = () => ({
      plain: ['──┐'],
      styled: [[{ text: '──┐', role: 'edge' }]],
      width: 3,
      classDefs: {},
      warnings: ['statement dropped'],
    });
    const markdown = new Markdown(fenceOnly(SIMPLE_FLOWCHART), 0, 0, createMarkdownTheme());

    expect(renderText(markdown, 100)).toContain('──┐');
  });

  it('falls back when the art is wider than the block and draws at the exact width', () => {
    const artWidth = renderMermaidSource(SIMPLE_FLOWCHART)?.width ?? 0;
    expect(artWidth).toBeGreaterThan(0);
    const markdown = new Markdown(fenceOnly(SIMPLE_FLOWCHART), 0, 0, createMarkdownTheme());

    expect(renderText(markdown, artWidth)).toContain('─');
    const narrow = renderText(markdown, artWidth - 1);
    expect(narrow).toContain('mermaid diagram too');
    expect(narrow).toContain('```mermaid');
  });

  it('explains the width shortfall with the required columns', () => {
    lovelyMock.renderBehavior = () => ({
      plain: ['─'],
      styled: [[{ text: '─', role: 'edge' }]],
      width: 60,
      classDefs: {},
      warnings: [],
    });
    const markdown = new Markdown(fenceOnly(SIMPLE_FLOWCHART), 0, 0, createMarkdownTheme());

    expect(renderText(markdown, 59)).toContain(
      'mermaid diagram too wide to render (needs 60 columns)',
    );
  });

  it('re-judges the width on every render as the terminal resizes', () => {
    const artWidth = renderMermaidSource(SIMPLE_FLOWCHART)?.width ?? 0;
    const markdown = new Markdown(fenceOnly(SIMPLE_FLOWCHART), 0, 0, createMarkdownTheme());

    expect(renderText(markdown, artWidth - 1)).toContain('mermaid diagram too');
    expect(renderText(markdown, artWidth)).toContain('─');
    expect(renderText(markdown, artWidth - 1)).toContain('mermaid diagram too');
  });

  it('truncates the reason line to the block columns', () => {
    const markdown = new Markdown(
      fenceOnly('gantt\n  Task :2026-01-01, 3d\n'),
      0,
      0,
      createMarkdownTheme(),
    );
    const lines = markdown.render(16);

    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(16);
    expect(lines.map(strip).join('\n')).toContain('…');
  });

  it('applies horizontal padding to art and judges width after padding', () => {
    const artWidth = renderMermaidSource(SIMPLE_FLOWCHART)?.width ?? 0;
    const markdown = new Markdown(fenceOnly(SIMPLE_FLOWCHART), 2, 0, createMarkdownTheme());

    const drawn = markdown.render(artWidth + 4);
    expect(drawn.map(strip).join('\n')).toContain('─');
    for (const line of drawn) expect(visibleWidth(line)).toBe(artWidth + 4);

    expect(renderText(markdown, artWidth + 3)).toContain('mermaid diagram too');
  });
});

describe('Markdown mermaid live updates', () => {
  it('redraws mounted markdown when the mode changes via invalidate', () => {
    setMarkdownMermaidMode('off');
    const markdown = new Markdown(fenceOnly(SIMPLE_FLOWCHART), 0, 0, createMarkdownTheme());
    expect(renderText(markdown, 80)).toContain('```mermaid');

    setMarkdownMermaidMode('final');
    markdown.invalidate();
    expect(renderText(markdown, 80)).toContain('─');

    setMarkdownMermaidMode('off');
    markdown.invalidate();
    const text = renderText(markdown, 80);
    expect(text).toContain('```mermaid');
    expect(text).not.toContain('─');
  });

  it('recolors drawn art through the live theme on invalidate', () => {
    const markdown = new Markdown(fenceOnly(SIMPLE_FLOWCHART), 0, 0, createMarkdownTheme());
    const darkOutput = markdown.render(80).join('\n');
    expect(darkOutput).toContain('38;2;90;90;90');

    currentTheme.setPalette(lightColors);
    markdown.invalidate();
    const lightOutput = markdown.render(80).join('\n');
    expect(lightOutput).toContain('38;2;115;115;115');
  });
});

describe('Markdown mermaid copy source', () => {
  function makeCopyable(): Markdown {
    return new Markdown(fenceOnly(SIMPLE_FLOWCHART), 0, 0, createMarkdownTheme(), undefined, {
      copySource: true,
    });
  }

  function pressButton(markdown: Markdown, lines: string[]) {
    return markdown.handleMouse(mouseEvent('press', 1, lines.length - 1, 80, lines.length));
  }

  function releaseOn(markdown: Markdown, x: number, y: number, lines: string[]) {
    return markdown.handleMouse(mouseEvent('release', x, y, 80, lines.length));
  }

  function lastLine(markdown: Markdown): string {
    return markdown.render(80).at(-1) ?? '';
  }

  it('shows no button without copySource even in alt screen', () => {
    setMarkdownAltScreenActive(true);
    const markdown = new Markdown(fenceOnly(SIMPLE_FLOWCHART), 0, 0, createMarkdownTheme());

    expect(renderText(markdown, 80)).not.toContain('[Copy Source]');
  });

  it('shows no button when alt screen is off even with copySource', () => {
    const markdown = makeCopyable();

    expect(renderText(markdown, 80)).not.toContain('[Copy Source]');
  });

  it('shows the button as plain primary text when copySource and alt screen are both on', () => {
    setMarkdownAltScreenActive(true);
    const line = lastLine(makeCopyable());

    expect(strip(line)).toContain('[Copy Source]');
    expect(line).toContain('38;2;91;192;190');
    expect(line).not.toContain('48;2;');
    expect(line).not.toContain('[1m');
  });

  it('shows the button under an undrawn fence as well', () => {
    setMarkdownAltScreenActive(true);
    const markdown = new Markdown(
      fenceOnly('gantt\n  Task :2026-01-01, 3d\n'),
      0,
      0,
      createMarkdownTheme(),
      undefined,
      { copySource: true },
    );
    const text = renderText(markdown, 100);

    expect(text).toContain('gantt diagrams are not drawn in the terminal');
    expect(text).toContain('[Copy Source]');
  });

  it('copies the fence body without the fences when the press is released on the button', async () => {
    setMarkdownAltScreenActive(true);
    clipboardMock.copyTextToClipboard.mockResolvedValue('native');
    const markdown = makeCopyable();
    const lines = markdown.render(80);

    const press = pressButton(markdown, lines);
    expect(press?.capture).toBe(true);
    const release = releaseOn(markdown, 1, lines.length - 1, lines);
    expect(release?.handled).toBe(true);

    await vi.waitFor(() => {
      expect(clipboardMock.copyTextToClipboard).toHaveBeenCalled();
    });
    const copied = clipboardMock.copyTextToClipboard.mock.calls[0]?.[0] ?? '';
    expect(copied).toContain('flowchart LR');
    expect(copied).toContain('A-->B');
    expect(copied).not.toContain('```');
  });

  it('emboldens the button while pressed and restores it on release', () => {
    setMarkdownAltScreenActive(true);
    clipboardMock.copyTextToClipboard.mockResolvedValue('native');
    const markdown = makeCopyable();
    const lines = markdown.render(80);

    expect(lastLine(markdown)).not.toContain('[1m');
    pressButton(markdown, lines);
    expect(lastLine(markdown)).toContain('[1m');
    releaseOn(markdown, 1, lines.length - 1, lines);
    expect(lastLine(markdown)).not.toContain('[1m');
  });

  it('cancels the press without copying when the pointer is dragged away before release', () => {
    setMarkdownAltScreenActive(true);
    clipboardMock.copyTextToClipboard.mockResolvedValue('native');
    const markdown = makeCopyable();
    const lines = markdown.render(80);

    pressButton(markdown, lines);
    expect(
      markdown.handleMouse(mouseEvent('drag', 40, lines.length - 1, 80, lines.length))?.handled,
    ).toBe(true);
    expect(releaseOn(markdown, 40, lines.length - 1, lines)?.handled).toBe(true);

    expect(clipboardMock.copyTextToClipboard).not.toHaveBeenCalled();
    expect(lastLine(markdown)).not.toContain('[1m');
  });

  it('does not copy when the press lands outside the button cells', () => {
    setMarkdownAltScreenActive(true);
    clipboardMock.copyTextToClipboard.mockResolvedValue('native');
    const markdown = makeCopyable();
    const lines = markdown.render(80);

    expect(
      markdown.handleMouse(mouseEvent('press', 40, lines.length - 1, 80, lines.length)),
    ).toBeUndefined();
    expect(markdown.handleMouse(mouseEvent('press', 1, 0, 80, lines.length))).toBeUndefined();
    expect(clipboardMock.copyTextToClipboard).not.toHaveBeenCalled();
  });

  it('briefly shows Copied after a successful copy', async () => {
    vi.useFakeTimers();
    try {
      setMarkdownAltScreenActive(true);
      const requestRender = vi.fn();
      setMarkdownRenderRequester(requestRender);
      clipboardMock.copyTextToClipboard.mockResolvedValue('native');
      const markdown = makeCopyable();
      const lines = markdown.render(80);

      pressButton(markdown, lines);
      releaseOn(markdown, 1, lines.length - 1, lines);
      await vi.advanceTimersByTimeAsync(0);
      expect(renderText(markdown, 80)).toContain('[Copied]');

      await vi.advanceTimersByTimeAsync(1600);
      expect(renderText(markdown, 80)).toContain('[Copy Source]');
      expect(requestRender).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows Copy failed when the clipboard write fails', async () => {
    setMarkdownAltScreenActive(true);
    clipboardMock.copyTextToClipboard.mockRejectedValue(new Error('no clipboard'));
    const markdown = makeCopyable();
    const lines = markdown.render(80);

    pressButton(markdown, lines);
    releaseOn(markdown, 1, lines.length - 1, lines);

    await vi.waitFor(() => {
      expect(renderText(markdown, 80)).toContain('[Copy failed]');
    });
  });

  it('keeps showing Copied until the latest acknowledgment elapses on repeated activations', async () => {
    vi.useFakeTimers();
    try {
      setMarkdownAltScreenActive(true);
      clipboardMock.copyTextToClipboard.mockResolvedValue('native');
      const markdown = makeCopyable();
      const lines = markdown.render(80);
      const activate = () => {
        pressButton(markdown, lines);
        releaseOn(markdown, 1, lines.length - 1, lines);
      };

      activate();
      await vi.advanceTimersByTimeAsync(1000);
      activate();
      await vi.advanceTimersByTimeAsync(1000);
      expect(renderText(markdown, 80)).toContain('[Copied]');

      await vi.advanceTimersByTimeAsync(600);
      expect(renderText(markdown, 80)).toContain('[Copy Source]');
    } finally {
      vi.useRealTimers();
    }
  });
});
