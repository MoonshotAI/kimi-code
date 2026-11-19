import { describe, expect, it } from 'vitest';
import {
  getAttachmentTooltipResolver,
  setAttachmentTooltipResolver,
  type AttachmentTooltipResolver,
} from '../../../src/features/attachment/tooltipResolver';

describe('attachmentTooltipResolver', () => {
  it('exposes the active resolver and clears it on release', () => {
    const resolver: AttachmentTooltipResolver = (attId) => ({ name: attId });
    const release = setAttachmentTooltipResolver(resolver);
    expect(getAttachmentTooltipResolver()).toBe(resolver);
    release();
    expect(getAttachmentTooltipResolver()).toBeNull();
  });

  it('does not let an older release clear the latest resolver', () => {
    const first: AttachmentTooltipResolver = () => ({ name: 'first' });
    const second: AttachmentTooltipResolver = () => ({ name: 'second' });
    const releaseFirst = setAttachmentTooltipResolver(first);
    const releaseSecond = setAttachmentTooltipResolver(second);
    releaseFirst();
    expect(getAttachmentTooltipResolver()).toBe(second);
    releaseSecond();
    expect(getAttachmentTooltipResolver()).toBeNull();
  });
});
