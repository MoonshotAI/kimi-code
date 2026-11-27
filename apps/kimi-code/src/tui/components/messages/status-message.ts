import {
  Container,
  renderComponentLines,
  Spacer,
  Text,
  textRenderLine,
  withRenderLineText,
} from '@moonshot-ai/pi-tui';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';

import { IndentedText } from './indented-text';
import type { TranscriptRowParts } from './transcript-row-layout';

export class StatusMessageComponent extends Container {
  private textComponent: IndentedText;
  private rowTextComponent: Text;
  private content: string;
  private color?: ColorToken;

  constructor(content: string, color?: ColorToken) {
    super();
    this.content = content;
    this.color = color;
    this.textComponent = new IndentedText(this.renderText());
    this.rowTextComponent = new Text(this.renderText(), 0, 0);
    this.addChild(this.textComponent);
  }

  updateContent(content: string): void {
    this.content = content;
    this.textComponent.setText(this.renderText());
    this.rowTextComponent.setText(this.renderText());
  }

  renderTranscriptRow(width: number): TranscriptRowParts {
    return renderIndentedTranscriptRow([this.rowTextComponent], width, false);
  }

  override invalidate(): void {
    this.textComponent.setText(this.renderText());
    this.rowTextComponent.setText(this.renderText());
    super.invalidate();
  }

  private renderText(): string {
    const colored =
      this.color === undefined
        ? currentTheme.fg('textDim', this.content)
        : currentTheme.fg(this.color, this.content);
    return colored.replaceAll('\r', '');
  }
}

export class NoticeMessageComponent extends Container {
  private titleText: IndentedText;
  private rowTitleText: Text;
  private detailText?: IndentedText;
  private rowDetailText?: Text;
  private title: string;
  private detail?: string;

  constructor(title: string, detail: string | undefined) {
    super();
    this.title = title;
    this.detail = detail;
    this.addChild(new Spacer(1));
    this.titleText = new IndentedText(currentTheme.fg('textStrong', title));
    this.rowTitleText = new Text(currentTheme.fg('textStrong', title), 0, 0);
    this.addChild(this.titleText);
    if (detail !== undefined && detail.length > 0) {
      this.detailText = new IndentedText(this.renderDetail(detail));
      this.rowDetailText = new Text(this.renderDetail(detail), 0, 0);
      this.addChild(this.detailText);
    }
  }

  renderTranscriptRow(width: number): TranscriptRowParts {
    const textComponents = [this.rowTitleText];
    if (this.rowDetailText !== undefined) textComponents.push(this.rowDetailText);
    return renderIndentedTranscriptRow(textComponents, width, true);
  }

  override invalidate(): void {
    this.titleText.setText(currentTheme.fg('textStrong', this.title));
    this.rowTitleText.setText(currentTheme.fg('textStrong', this.title));
    if (this.detailText !== undefined && this.detail !== undefined) {
      this.detailText.setText(this.renderDetail(this.detail));
      this.rowDetailText?.setText(this.renderDetail(this.detail));
    }
    super.invalidate();
  }

  private renderDetail(detail: string): string {
    return currentTheme.fg('textDim', detail);
  }
}

function renderIndentedTranscriptRow(
  textComponents: readonly Text[],
  width: number,
  leadingBlank: boolean,
): TranscriptRowParts {
  const safeWidth = Math.max(0, width);
  if (safeWidth <= 0) {
    const contentLines = Array.from(
      { length: textComponents.length + (leadingBlank ? 1 : 0) },
      () => textRenderLine(''),
    );
    return { gutterWidth: 0, gutterLines: contentLines, contentLines };
  }
  const gutterWidth = Math.min(MESSAGE_INDENT.length, Math.max(0, safeWidth - 1));
  const contentWidth = Math.max(1, safeWidth - gutterWidth);
  const contentLines = textComponents.flatMap((component) =>
    renderComponentLines(component, contentWidth).map((line) =>
      withRenderLineText(line, line.text.trimEnd()),
    ),
  );
  if (leadingBlank) contentLines.unshift(textRenderLine(''));
  return {
    gutterWidth,
    gutterLines: contentLines.map((line) =>
      textRenderLine(line.text.length === 0 ? '' : MESSAGE_INDENT.slice(0, gutterWidth)),
    ),
    contentLines,
  };
}
