import { Key, matchesKey, type Terminal } from '@moonshot-ai/pi-tui';

import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';
import type { DiffDisplayBlock, FileContentDisplayBlock } from '#/tui/reverse-rpc/types';
import { currentTheme } from '#/tui/theme';

import {
  fitViewerLine,
  FramedScrollViewer,
  type ViewerFooterItem,
} from './framed-scroll-viewer';

export type ApprovalPreviewBlock = DiffDisplayBlock | FileContentDisplayBlock;

export interface ApprovalPreviewViewerProps {
  readonly block: ApprovalPreviewBlock;
  readonly onClose: () => void;
  readonly requestRender?: () => void;
}

export class ApprovalPreviewViewer extends FramedScrollViewer {
  private readonly props: ApprovalPreviewViewerProps;
  private bodyLines: string[];
  private headerTitle: string;

  constructor(props: ApprovalPreviewViewerProps, terminal: Terminal) {
    super({ terminal, requestRender: props.requestRender });
    this.props = props;
    const built = buildBody(props.block);
    this.bodyLines = built.lines;
    this.headerTitle = built.title;
  }

  override invalidate(): void {
    const built = buildBody(this.props.block);
    this.bodyLines = built.lines;
    this.headerTitle = built.title;
    super.invalidate();
  }

  protected override handleExtraKey(data: string): boolean {
    if (matchesKey(data, Key.ctrl('e'))) {
      this.props.onClose();
      return true;
    }
    return false;
  }

  protected renderHeaderLine(width: number): string {
    const title = currentTheme.boldFg('primary', ' Preview ');
    return fitViewerLine(title + this.headerTitle, width);
  }

  protected getBodyLines(): readonly string[] {
    return this.bodyLines;
  }

  protected getFooterItems(): readonly ViewerFooterItem[] {
    return [
      { keys: '↑↓', label: 'line' },
      { keys: 'PgUp/PgDn', label: 'page' },
      { keys: 'g/G', label: 'top/bot' },
      { keys: 'Q/Esc/Ctrl+E', label: 'cancel', onClick: () => this.props.onClose() },
    ];
  }

  protected onClose(): void {
    this.props.onClose();
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
  const rendered = renderDiffLinesClustered(
    block.old_text,
    block.new_text,
    block.path,
    {
      contextLines: 3,
      oldStart: block.old_start ?? 1,
      newStart: block.new_start ?? 1,
    },
  );
  const [header = '', ...rest] = rendered;
  return { lines: rest, title: header.replace(/^ +/, '') };
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
