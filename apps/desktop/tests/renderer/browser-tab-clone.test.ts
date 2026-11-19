import { describe, expect, it } from 'vitest';
import { clonedBrowserTabPayload } from '../../src/renderer/lib/browserTabClone';

const state = { title: 'Cloned', favicon: 'data:image/png;base64,clone' };

describe('clonedBrowserTabPayload', () => {
  it('takes the fresh title and favicon and keeps the custom name', () => {
    expect(clonedBrowserTabPayload({ browserId: 'browser-1', title: 'Old', customTitle: 'Docs', favicon: 'old' }, 'browser-2', state)).toEqual({
      browserId: 'browser-2',
      title: 'Cloned',
      customTitle: 'Docs',
      favicon: 'data:image/png;base64,clone',
    });
  });

  it('falls back to the source title and favicon when the clone has none', () => {
    expect(clonedBrowserTabPayload({ browserId: 'browser-1', title: 'Old', favicon: 'old' }, 'browser-2', { title: '', favicon: undefined })).toEqual({
      browserId: 'browser-2',
      title: 'Old',
      customTitle: undefined,
      favicon: 'old',
    });
  });

});
