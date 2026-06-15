import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';

const image: ImageAttachment = {
  id: 1,
  kind: 'image',
  bytes: new Uint8Array([137, 80, 78, 71]),
  mime: 'image/png',
  width: 800,
  height: 600,
  placeholder: '[image #1 (800×600)]',
};

describe('ImageThumbnail', () => {
  it('keeps rendered output within narrow widths', () => {
    const component = new ImageThumbnail(image);

    for (const width of [39, 20, 3, 1]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
