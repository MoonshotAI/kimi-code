/**
 * Renders a user message in the transcript.
 */

import { Spacer, Text, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import { USER_MESSAGE_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';

export class UserMessageComponent implements Component {
  private text: string;
  private spacerComponent: Spacer;
  private imageThumbnails: ImageThumbnail[];

  constructor(text: string, images?: ImageAttachment[]) {
    this.text = text;
    this.spacerComponent = new Spacer(1);
    this.imageThumbnails = images?.map((img) => new ImageThumbnail(img)) ?? [];
  }

  invalidate(): void {
    for (const img of this.imageThumbnails) {
      img.invalidate?.();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const bullet = currentTheme.boldFg('roleUser', USER_MESSAGE_BULLET);
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, safeWidth - bulletWidth);

    const lines: string[] = [];

    // Spacer
    for (const line of this.spacerComponent.render(safeWidth)) {
      lines.push(line);
    }

    // Text — re-dye on every render so theme switches are reflected
    const coloredText = currentTheme.boldFg('roleUser', this.text);
    const textLines = new Text(coloredText, 0, 0).render(contentWidth);
    for (let i = 0; i < textLines.length; i++) {
      const prefix = i === 0 ? bullet : ' '.repeat(bulletWidth);
      lines.push(prefix + textLines[i]);
    }

    // Images — indented to align with text after the bullet
    for (const thumbnail of this.imageThumbnails) {
      const imageLines = thumbnail.render(contentWidth);
      for (const line of imageLines) {
        lines.push(' '.repeat(bulletWidth) + line);
      }
    }

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
