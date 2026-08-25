// packages/app-composer/test/mention-tooltip.test.ts
// The attachment pill identity/size the mentionTooltip singleton reads back
// from a pill's data attributes — the message side's only metadata source
// (no registry resolves there), so the tooltip's degraded name + size-tail
// recipe (DesignSystemView §05) depends on this parse.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isBubbleInternalScroll, pillAttachment } from '../src/mentionTooltip';

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

describe('isBubbleInternalScroll (long-quote tooltip scroll guard)', () => {
  class FakeNode {}
  const inner = new FakeNode();
  const outer = new FakeNode();
  const bubble = { contains: (target: unknown) => target === inner } as unknown as HTMLElement;
  let savedNode: unknown;

  beforeEach(() => {
    savedNode = (globalThis as { Node?: unknown }).Node;
    (globalThis as { Node?: unknown }).Node = FakeNode;
  });
  afterEach(() => {
    (globalThis as { Node?: unknown }).Node = savedNode;
  });

  it('a scroll from inside the bubble is NOT an outside scroll', () => {
    expect(isBubbleInternalScroll(bubble, inner as unknown as EventTarget)).toBe(true);
  });

  it('a scroll from anywhere else (or with no bubble) dismisses', () => {
    expect(isBubbleInternalScroll(bubble, outer as unknown as EventTarget)).toBe(false);
    expect(isBubbleInternalScroll(null, inner as unknown as EventTarget)).toBe(false);
    expect(isBubbleInternalScroll(bubble, null)).toBe(false);
  });

  it('a non-Node target (window.resize’s Window) is an outside event — no throw', () => {
    const windowLike = { id: 'window' } as unknown as EventTarget;
    expect(() => isBubbleInternalScroll(bubble, windowLike)).not.toThrow();
    expect(isBubbleInternalScroll(bubble, windowLike)).toBe(false);
  });
});
