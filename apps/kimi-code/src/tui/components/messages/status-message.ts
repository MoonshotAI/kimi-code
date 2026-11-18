import { Container, Spacer, Text } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';

export class StatusMessageComponent extends Container {
  private textComponent: Text;
  private content: string;
  private color?: ColorToken;

  constructor(content: string, color?: ColorToken) {
    super();
    this.content = content;
    this.color = color;
    this.textComponent = new Text(this.renderText(), 0, 0);
    this.addChild(this.textComponent);
  }

  updateContent(content: string): void {
    this.content = content;
    this.textComponent.setText(this.renderText());
  }

  override invalidate(): void {
    this.textComponent.setText(this.renderText());
    super.invalidate();
  }

  private renderText(): string {
    const colored =
      this.color === undefined
        ? currentTheme.fg('textDim', this.content)
        : currentTheme.fg(this.color, this.content);
    return colored.replaceAll('\r', '').split('\n').map((line) => `  ${line}`).join('\n');
  }
}

export class NoticeMessageComponent extends Container {
  private titleText: Text;
  private detailText?: Text;
  private title: string;
  private detail?: string;

  constructor(title: string, detail: string | undefined) {
    super();
    this.title = title;
    this.detail = detail;
    this.addChild(new Spacer(1));
    this.titleText = new Text(`  ${currentTheme.fg('textStrong', title)}`, 0, 0);
    this.addChild(this.titleText);
    if (detail !== undefined && detail.length > 0) {
      this.detailText = new Text(this.renderDetail(detail), 0, 0);
      this.addChild(this.detailText);
    }
  }

  override invalidate(): void {
    this.titleText.setText(`  ${currentTheme.fg('textStrong', this.title)}`);
    if (this.detailText !== undefined && this.detail !== undefined) {
      this.detailText.setText(this.renderDetail(this.detail));
    }
    super.invalidate();
  }

  private renderDetail(detail: string): string {
    return currentTheme.fg('textDim', detail).split('\n').map((line) => `  ${line}`).join('\n');
  }
}
