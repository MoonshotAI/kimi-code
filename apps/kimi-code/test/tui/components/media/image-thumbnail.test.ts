import { getCapabilities, visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';

vi.mock('@earendil-works/pi-tui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-tui')>();
  return {
    ...actual,
    getCapabilities: vi.fn(() => ({ images: undefined, trueColor: false, hyperlinks: false })),
  };
});

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps rendered output within narrow widths', () => {
    vi.mocked(getCapabilities).mockReturnValue({ images: undefined } as never);
    const component = new ImageThumbnail(image);

    for (const width of [39, 20, 3, 1]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('does not rebuild inline image children on repeated same-width renders', () => {
    vi.mocked(getCapabilities).mockReturnValue({ images: 'kitty' } as never);
    const bufferFrom = vi.spyOn(Buffer, 'from');
    const component = new ImageThumbnail(image);
    bufferFrom.mockClear();

    component.render(80);
    component.render(80);

    expect(bufferFrom).not.toHaveBeenCalled();
  });
});
