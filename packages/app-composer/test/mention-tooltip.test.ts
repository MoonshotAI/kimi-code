// packages/app-composer/test/mention-tooltip.test.ts
// The attachment pill identity/size the mentionTooltip singleton reads back
// from a pill's data attributes — the message side's only metadata source
// (no registry resolves there), so the tooltip's degraded name + size-tail
// recipe (DesignSystemView §05) depends on this parse.
import { describe, expect, it } from 'vitest';
import { pillAttachment } from '../src/mentionTooltip';

/** A dataset-only stub — pillAttachment reads pill.dataset (and the name
 *  fallback's querySelector only when data-attachment-name is absent). */
function pill(dataset: Record<string, string>): HTMLElement {
  return { dataset } as unknown as HTMLElement;
}

describe('pillAttachment (data-attribute readback)', () => {
  it('reads the identity and a numeric size', () => {
    expect(
      pillAttachment(
        pill({
          attachmentId: '2',
          attachmentKind: 'file',
          attachmentName: 'report.pdf',
          attachmentSize: '4096',
        }),
      ),
    ).toEqual({ attId: '2', kind: 'file', name: 'report.pdf', size: 4096 });
  });

  it('treats a missing or empty size as unknown (no size tail)', () => {
    expect(
      pillAttachment(pill({ attachmentId: '1', attachmentKind: 'file', attachmentName: 'a.pdf' })).size,
    ).toBeUndefined();
    expect(
      pillAttachment(pill({ attachmentId: '1', attachmentKind: 'file', attachmentName: 'a.pdf', attachmentSize: '' })).size,
    ).toBeUndefined();
  });

  it('drops a non-numeric size instead of showing garbage', () => {
    expect(
      pillAttachment(pill({ attachmentId: '1', attachmentKind: 'file', attachmentName: 'a.pdf', attachmentSize: 'big' })).size,
    ).toBeUndefined();
  });

  it('keeps a zero size (an empty file is a real size)', () => {
    expect(
      pillAttachment(pill({ attachmentId: '1', attachmentKind: 'file', attachmentName: 'e.txt', attachmentSize: '0' })).size,
    ).toBe(0);
  });

  it('reads the folder kind from the data attribute', () => {
    expect(pillAttachment(pill({ attachmentId: 'x', attachmentKind: 'folder', attachmentName: 'src/' })).kind).toBe('folder');
  });
});
