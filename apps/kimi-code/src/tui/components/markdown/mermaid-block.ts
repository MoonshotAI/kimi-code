import {
  Markdown as PiMarkdown,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { KimiMarkdownOptions } from '#/tui/components/markdown/markdown';
import {
  isMarkdownAltScreenActive,
  requestMarkdownRender,
} from '#/tui/utils/markdown-options';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';

import { colorMermaidArt, COULD_NOT_DRAW_MESSAGE, drawMermaid, undrawnDiagramReason } from './mermaid-art';

const COPY_SOURCE_LABEL = '[Copy Source]';
const COPIED_LABEL = '[Copied]';
const COPY_FAILED_LABEL = '[Copy failed]';
const COPIED_REVERT_MS = 1500;

type CopyState = 'idle' | 'copied' | 'failed';

export class MermaidBlock implements Component {
  private copyState: CopyState = 'idle';
  private pressed = false;
  private copyRevertTimer: ReturnType<typeof setTimeout> | undefined;
  private codeMarkdown: PiMarkdown | undefined;
  private layout:
    | {
        width: number;
        copyState: CopyState;
        pressed: boolean;
        showButton: boolean;
        lines: string[];
      }
    | undefined;

  constructor(
    private readonly fenceBody: string,
    private readonly fenceRaw: string,
    private readonly paddingX: number,
    private readonly theme: MarkdownTheme,
    private readonly options: KimiMarkdownOptions,
  ) {}

  invalidate(): void {
    this.layout = undefined;
    this.codeMarkdown = undefined;
  }

  render(width: number): string[] {
    const showButton = this.showsCopyButton();
    if (
      this.layout !== undefined &&
      this.layout.width === width &&
      this.layout.copyState === this.copyState &&
      this.layout.pressed === this.pressed &&
      this.layout.showButton === showButton
    ) {
      return this.layout.lines;
    }

    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const content: string[] = [];
    const draw = drawMermaid(this.fenceBody);
    if (draw.status === 'ok' && draw.art !== null && draw.art.width <= contentWidth) {
      content.push(...colorMermaidArt(draw.art));
    } else {
      const reason =
        draw.status === 'error'
          ? COULD_NOT_DRAW_MESSAGE
          : draw.art !== null
            ? `mermaid diagram too wide to render (needs ${draw.art.width} columns)`
            : undrawnDiagramReason(this.fenceBody);
      content.push(currentTheme.fg('warning', truncateToWidth(reason, contentWidth, '…')));
      this.codeMarkdown ??= new PiMarkdown(this.fenceRaw, 0, 0, this.theme, undefined, this.options);
      content.push(...this.codeMarkdown.render(contentWidth));
    }
    if (showButton) {
      const label = truncateToWidth(this.copyLabel(), contentWidth, '…');
      content.push(this.styledCopyLabel(label));
    }

    const leftMargin = ' '.repeat(this.paddingX);
    const rightMargin = ' '.repeat(this.paddingX);
    const lines = content.map((line) => {
      const withMargins = leftMargin + line + rightMargin;
      return withMargins + ' '.repeat(Math.max(0, width - visibleWidth(withMargins)));
    });
    this.layout = { width, copyState: this.copyState, pressed: this.pressed, showButton, lines };
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.showsCopyButton()) return undefined;
    const lines = this.render(event.width);
    if (lines.length === 0) return undefined;
    const label = truncateToWidth(this.copyLabel(), Math.max(1, event.width - this.paddingX * 2), '…');
    const x = event.x - this.paddingX;
    const onLabel = event.y === lines.length - 1 && x >= 0 && x < visibleWidth(label);

    if (event.type === 'press') {
      if (!onLabel || event.button !== 'left') return undefined;
      this.pressed = true;
      this.options.onVisualStateChange?.();
      return { capture: true, render: true };
    }
    if (event.type === 'drag') {
      return this.pressed ? { handled: true } : undefined;
    }
    if (event.type === 'release') {
      if (!this.pressed) return undefined;
      this.pressed = false;
      this.options.onVisualStateChange?.();
      if (onLabel) this.copySource();
      return { handled: true, render: true };
    }
    return undefined;
  }

  private showsCopyButton(): boolean {
    return this.options.copySource === true && isMarkdownAltScreenActive();
  }

  private styledCopyLabel(label: string): string {
    if (this.copyState === 'copied') {
      return currentTheme.fg('success', label);
    }
    if (this.copyState === 'failed') {
      return currentTheme.fg('warning', label);
    }
    if (this.pressed) {
      return currentTheme.boldFg('accent', label);
    }
    return currentTheme.fg('accent', label);
  }

  private copyLabel(): string {
    if (this.copyState === 'copied') return COPIED_LABEL;
    if (this.copyState === 'failed') return COPY_FAILED_LABEL;
    return COPY_SOURCE_LABEL;
  }

  private copySource(): void {
    void copyTextToClipboard(this.fenceBody).then(
      () => {
        this.copyState = 'copied';
        this.options.onVisualStateChange?.();
        requestMarkdownRender();
        if (this.copyRevertTimer !== undefined) clearTimeout(this.copyRevertTimer);
        this.copyRevertTimer = setTimeout(() => {
          this.copyRevertTimer = undefined;
          this.copyState = 'idle';
          this.options.onVisualStateChange?.();
          requestMarkdownRender();
        }, COPIED_REVERT_MS);
        this.copyRevertTimer.unref?.();
      },
      () => {
        this.copyState = 'failed';
        this.options.onVisualStateChange?.();
        requestMarkdownRender();
      },
    );
  }
}
