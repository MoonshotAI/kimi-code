/**
 * Transcript-side rendering of a pasted image.
 *
 * On terminals that speak the Kitty graphics protocol or iTerm2 inline
 * image protocol (detected by pi-tui's `getCapabilities()`), we show
 * the actual image. Everywhere else we fall back to a one-line text
 * marker matching the placeholder the user sees in the input box —
 * this keeps the transcript readable on Terminal.app / Linux default
 * terminals / `script` recordings without extra chrome.
 *
 * Height is capped at ~12 rows so a single screenshot can't monopolize
 * the viewport; pi-tui handles proportional scaling internally.
 */

import { Container, Image, Text, type ImageTheme, getCapabilities } from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';

const MAX_IMAGE_ROWS = 12;
const MAX_IMAGE_WIDTH = 40;

export class ImageThumbnail extends Container {
  private readonly attachment: ImageAttachment;

  constructor(attachment: ImageAttachment) {
    super();
    this.attachment = attachment;
    this.buildChildren();
  }

  private buildChildren(): void {
    this.clear();
    const caps = getCapabilities();
    const supportsInline = caps.images === 'kitty' || caps.images === 'iterm2';

    if (!supportsInline) {
      // Non-graphic terminal — show the placeholder text in accent colour so
      // it's clearly an attachment reference but doesn't shout.
      this.addChild(new Text(currentTheme.fg('accent', this.attachment.placeholder), 0, 0));
      return;
    }

    const theme: ImageTheme = {
      fallbackColor: (s: string) => currentTheme.fg('textDim', s),
    };
    const base64 = Buffer.from(this.attachment.bytes).toString('base64');
    const image = new Image(
      base64,
      this.attachment.mime,
      theme,
      {
        maxHeightCells: MAX_IMAGE_ROWS,
        maxWidthCells: MAX_IMAGE_WIDTH,
        filename: this.attachment.placeholder,
      },
      { widthPx: this.attachment.width, heightPx: this.attachment.height },
    );
    this.addChild(image);
  }

  override invalidate(): void {
    this.buildChildren();
    super.invalidate();
  }
}
