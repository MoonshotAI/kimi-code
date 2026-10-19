import {
  Container,
  Marked,
  Markdown as PiMarkdown,
  Spacer,
  type DefaultTextStyle,
  type MarkdownOptions,
  type MarkdownTheme,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
} from '@moonshot-ai/pi-tui';

import type { KimiMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { getMarkdownMermaidMode, type MermaidRenderMode } from '#/tui/utils/markdown-options';

import { MermaidBlock } from './mermaid-block';

export interface KimiMarkdownOptions extends MarkdownOptions {
  copySource?: boolean;
  onVisualStateChange?: () => void;
}

type MermaidSegment =
  | { kind: 'prose'; source: string; spacedBefore: boolean }
  | { kind: 'mermaid'; body: string; raw: string; spacedBefore: boolean };

const markdownParser = new Marked();

function splitMermaidSegments(source: string): MermaidSegment[] {
  const segments: MermaidSegment[] = [];
  let prose = '';
  let proseSpacedBefore = true;
  let previousWasSpace = true;
  for (const token of markdownParser.lexer(source)) {
    if (token.type === 'code' && isMermaidInfoString(token.lang)) {
      if (prose !== '') {
        segments.push({ kind: 'prose', source: prose, spacedBefore: proseSpacedBefore });
        prose = '';
      }
      segments.push({
        kind: 'mermaid',
        body: token.text,
        raw: token.raw,
        spacedBefore: previousWasSpace,
      });
      previousWasSpace = false;
      continue;
    }
    if (prose === '') {
      proseSpacedBefore = previousWasSpace || token.type === 'space';
    }
    prose += token.raw;
    previousWasSpace = token.type === 'space';
  }
  if (prose !== '') {
    segments.push({ kind: 'prose', source: prose, spacedBefore: proseSpacedBefore });
  }
  return segments;
}

function isMermaidInfoString(lang: string | undefined): boolean {
  return lang?.trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid';
}

interface MarkdownStructure {
  text: string;
  mode: MermaidRenderMode;
  transient: boolean;
}

export class Markdown extends Container {
  private sourceText: string;
  private readonly paddingX: number;
  private readonly paddingY: number;
  private readonly theme: MarkdownTheme;
  private readonly defaultTextStyle?: DefaultTextStyle;
  private readonly options: KimiMarkdownOptions;
  private structure: MarkdownStructure | undefined;

  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    theme: MarkdownTheme,
    defaultTextStyle?: DefaultTextStyle,
    options?: KimiMarkdownOptions,
  ) {
    super();
    this.sourceText = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.theme = theme;
    this.defaultTextStyle = defaultTextStyle;
    this.options = options ? { ...options } : {};
  }

  setText(text: string): void {
    this.sourceText = text;
    this.invalidate();
  }

  override invalidate(): void {
    this.structure = undefined;
    super.invalidate();
  }

  override render(width: number): string[] {
    if (this.sourceText.trim() === '') return [];
    this.ensureStructure();
    const lines = super.render(width);
    if (this.paddingY === 0) return lines;
    const bgFn = this.defaultTextStyle?.bgColor;
    const empty = ' '.repeat(Math.max(0, width));
    const margins = Array.from({ length: this.paddingY }, () => (bgFn ? bgFn(empty) : empty));
    return [...margins, ...lines, ...margins];
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    if (this.paddingY === 0) return super.handleMouse(event);
    if (event.y < this.paddingY) return undefined;
    return super.handleMouse({
      ...event,
      y: event.y - this.paddingY,
      height: event.height - this.paddingY * 2,
    });
  }

  private ensureStructure(): void {
    const mode = getMarkdownMermaidMode();
    const transient = (this.theme as KimiMarkdownTheme).transient === true;
    if (
      this.structure !== undefined &&
      this.structure.text === this.sourceText &&
      this.structure.mode === mode &&
      this.structure.transient === transient
    ) {
      return;
    }
    this.structure = { text: this.sourceText, mode, transient };
    this.clear();
    if (mode === 'off' || transient) {
      this.addChild(
        new PiMarkdown(
          this.sourceText,
          this.paddingX,
          0,
          this.theme,
          this.defaultTextStyle,
          this.options,
        ),
      );
      return;
    }
    for (const [index, segment] of splitMermaidSegments(this.sourceText).entries()) {
      if (index > 0 && !segment.spacedBefore) this.addChild(new Spacer(1));
      this.addChild(
        segment.kind === 'prose'
          ? new PiMarkdown(
              segment.source,
              this.paddingX,
              0,
              this.theme,
              this.defaultTextStyle,
              this.options,
            )
          : new MermaidBlock(segment.body, segment.raw, this.paddingX, this.theme, this.options),
      );
    }
  }
}
