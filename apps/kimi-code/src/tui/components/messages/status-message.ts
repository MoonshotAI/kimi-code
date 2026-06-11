import { Container, Spacer, Text } from '@earendil-works/pi-tui';

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
    const text = color === undefined
      ? currentTheme.fg('textDim', content)
      : currentTheme.fg(color, content);
    this.textComponent = new Text(`  ${text}`, 0, 0);
    this.addChild(this.textComponent);
  }

  override invalidate(): void {
    const text = this.color === undefined
      ? currentTheme.fg('textDim', this.content)
      : currentTheme.fg(this.color, this.content);
    this.textComponent.setText(`  ${text}`);
    super.invalidate();
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
      this.detailText = new Text(`  ${currentTheme.fg('textDim', detail)}`, 0, 0);
      this.addChild(this.detailText);
    }
  }

  override invalidate(): void {
    this.titleText.setText(`  ${currentTheme.fg('textStrong', this.title)}`);
    if (this.detailText !== undefined && this.detail !== undefined) {
      this.detailText.setText(`  ${currentTheme.fg('textDim', this.detail)}`);
    }
    super.invalidate();
  }
}
