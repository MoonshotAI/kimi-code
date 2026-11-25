import { Key, matchesKey, type Terminal } from '@moonshot-ai/pi-tui';

import {
  ScreenTakeoverView,
  fitLineExactly,
  handleScrollViewerKey,
  scrollFooterHints,
  type FramedScrollPane,
} from '#/tui/components/chrome/screen-takeover-view';
import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';
import type { DiffDisplayBlock, FileContentDisplayBlock } from '#/tui/reverse-rpc/types';
import { currentTheme, type ColorPalette } from '#/tui/theme';

export type ApprovalPreviewBlock = DiffDisplayBlock | FileContentDisplayBlock;

export interface ApprovalPreviewViewerProps {
  readonly block: ApprovalPreviewBlock;
  readonly onClose: () => void;
}

export class ApprovalPreviewViewer extends ScreenTakeoverView {
  private readonly props: ApprovalPreviewViewerProps;
  private bodyLines: string[];
  private headerTitle: string;
  private builtPalette: ColorPalette;
  private readonly pane: FramedScrollPane;

  constructor(props: ApprovalPreviewViewerProps, terminal: Terminal) {
    super(terminal);
    this.props = props;
    const built = buildBody(props.block);
    this.bodyLines = built.lines;
    this.headerTitle = built.title;
    this.builtPalette = currentTheme.palette;
    this.pane = this.mountSinglePane<'close'>({
      follow: 'none',
      initialPosition: 'start',
      renderHeader: (width) => this.renderHeader(width),
      renderContent: (width) => this.renderContent(width),
      footerHints: () => scrollFooterHints('PgUp/PgDn', 'Q/Esc/Ctrl+E', 'close'),
      onFooterAction: () => {
        this.props.onClose();
      },
    });
  }

  private ensureBuilt(): void {
    if (this.builtPalette === currentTheme.palette) return;
    const built = buildBody(this.props.block);
    this.bodyLines = built.lines;
    this.headerTitle = built.title;
    this.builtPalette = currentTheme.palette;
  }

  handleInput(data: string): void {
    const handled = handleScrollViewerKey(this.pane.scrollView, data, {
      onClose: () => this.props.onClose(),
      onExtraKey: (input) => {
        if (!matchesKey(input, Key.ctrl('e'))) return false;
        this.props.onClose();
        return true;
      },
    });
    if (handled) this.invalidate();
  }

  private renderContent(width: number): string[] {
    this.ensureBuilt();
    const innerWidth = Math.max(1, width);
    return this.bodyLines.map((raw) => fitLineExactly(raw, innerWidth));
  }

  private renderHeader(width: number): string {
    this.ensureBuilt();
    const title = currentTheme.boldFg('primary', ' Preview ');
    return fitLineExactly(title + this.headerTitle, width);
  }
}

interface BuiltBody {
  lines: string[];
  title: string;
}

function buildBody(block: ApprovalPreviewBlock): BuiltBody {
  if (block.type === 'diff') {
    return buildDiffBody(block);
  }
  return buildFileContentBody(block);
}

function buildDiffBody(block: DiffDisplayBlock): BuiltBody {
  const rendered = renderDiffLinesClustered(block.old_text, block.new_text, block.path, {
    contextLines: 3,
    oldStart: block.old_start ?? 1,
    newStart: block.new_start ?? 1,
  });
  const [header = '', ...rest] = rendered;
  return { lines: rest, title: stripLeadingSpace(header) };
}

function buildFileContentBody(block: FileContentDisplayBlock): BuiltBody {
  const lang = block.language ?? langFromPath(block.path);
  const highlighted = highlightLines(block.content, lang);
  const lines = highlighted.map(
    (line, i) => currentTheme.fg('diffGutter', String(i + 1).padStart(4) + '  ') + line,
  );
  const title = currentTheme.fg('textStrong', block.path);
  return { lines, title };
}

function stripLeadingSpace(s: string): string {
  return s.replace(/^ +/, '');
}
