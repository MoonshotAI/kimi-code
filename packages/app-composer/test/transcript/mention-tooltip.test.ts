import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consumeSelectedMediaEscape,
  formatAttachmentSize,
  isBubbleInternalScroll,
  isPointInTooltipHoverRegion,
  isSameTooltipPill,
  mediaProgressRingDash,
  pillAttachment,
} from '../../src/transcript/mentionTooltipUtils';

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

  it('reads the media kinds from the data attribute (unknown kinds fall back to file)', () => {
    expect(pillAttachment(pill({ attachmentId: 'x', attachmentKind: 'image', attachmentName: 'a.png' })).kind).toBe('image');
    expect(pillAttachment(pill({ attachmentId: 'x', attachmentKind: 'video', attachmentName: 'a.mp4' })).kind).toBe('video');
    expect(pillAttachment(pill({ attachmentId: 'x', attachmentKind: 'widget', attachmentName: 'a.w' })).kind).toBe('file');
  });
});

describe('isBubbleInternalScroll', () => {
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

  it('returns true for a target inside the bubble', () => {
    expect(isBubbleInternalScroll(bubble, inner as unknown as EventTarget)).toBe(true);
  });

  it('returns false for an outside target or a missing bubble', () => {
    expect(isBubbleInternalScroll(bubble, outer as unknown as EventTarget)).toBe(false);
    expect(isBubbleInternalScroll(null, inner as unknown as EventTarget)).toBe(false);
    expect(isBubbleInternalScroll(bubble, null)).toBe(false);
  });

  it('handles a non-Node target without throwing', () => {
    const windowLike = { id: 'window' } as unknown as EventTarget;
    expect(() => isBubbleInternalScroll(bubble, windowLike)).not.toThrow();
    expect(isBubbleInternalScroll(bubble, windowLike)).toBe(false);
  });
});

describe('mediaProgressRingDash', () => {
  it('draws pct of the r=6.5 circumference as the dash, the rest as the gap', () => {
    expect(mediaProgressRingDash(0)).toBe('0.0 40.84');
    expect(mediaProgressRingDash(0.62)).toBe('25.3 40.84');
    expect(mediaProgressRingDash(1)).toBe('40.8 40.84');
  });

  it('clamps out-of-range progress instead of drawing nonsense', () => {
    expect(mediaProgressRingDash(-0.5)).toBe('0.0 40.84');
    expect(mediaProgressRingDash(1.5)).toBe('40.8 40.84');
  });
});

describe('formatAttachmentSize', () => {
  it('formats the existing B/KB/MB display buckets', () => {
    expect(formatAttachmentSize(42)).toBe('42 B');
    expect(formatAttachmentSize(2048)).toBe('2 KB');
    expect(formatAttachmentSize(1024 * 1024 * 1.5)).toBe('1.5 MB');
  });
});

describe('isPointInTooltipHoverRegion', () => {
  const anchor = { left: 100, right: 180, top: 100, bottom: 124 };
  const bubble = { left: 80, right: 260, top: 40, bottom: 94 };

  it('keeps the popover open over the pill, the bubble, and their small hover slop', () => {
    expect(isPointInTooltipHoverRegion(120, 110, anchor, bubble)).toBe(true);
    expect(isPointInTooltipHoverRegion(120, 60, anchor, bubble)).toBe(true);
    expect(isPointInTooltipHoverRegion(96, 110, anchor, bubble)).toBe(true);
    expect(isPointInTooltipHoverRegion(120, 98, anchor, bubble)).toBe(true);
  });

  it('does not make the popover sticky once the pointer has genuinely left', () => {
    expect(isPointInTooltipHoverRegion(90, 110, anchor, bubble)).toBe(false);
    expect(isPointInTooltipHoverRegion(120, 132, anchor, bubble)).toBe(false);
  });
});

describe('isSameTooltipPill', () => {
  function attachmentPill(
    dataset: Record<string, string>,
    owner: { turnId?: string; editor?: HTMLElement } = { turnId: 'turn-1' },
  ): HTMLElement {
    const turn = owner.turnId === undefined ? null : ({ dataset: { turnId: owner.turnId } } as HTMLElement);
    return {
      dataset,
      classList: {
        contains: (name: string) => name === 'attachment-pill',
      },
      closest: (selector: string) =>
        selector === '.ProseMirror' ? (owner.editor ?? null) : selector === '[data-turn-id]' ? turn : null,
    } as unknown as HTMLElement;
  }

  it('recognizes a rerendered copy of the same attachment pill', () => {
    const first = attachmentPill({
      attachmentId: 'm1',
      attachmentKind: 'image',
      attachmentName: 'shot.png',
      attachmentFileId: 'f_img',
    });
    const replacement = attachmentPill({
      attachmentId: 'm1',
      attachmentKind: 'image',
      attachmentName: 'shot.png',
      attachmentFileId: 'f_img',
    });
    expect(isSameTooltipPill(first, replacement)).toBe(true);
  });

  it('does not conflate two messages whose media both use the local m1 index', () => {
    const first = attachmentPill({
      attachmentId: 'm1',
      attachmentKind: 'image',
      attachmentName: 'shot.png',
      attachmentFileId: 'f_first',
    }, { turnId: 'turn-1' });
    const other = attachmentPill({
      attachmentId: 'm1',
      attachmentKind: 'image',
      attachmentName: 'shot.png',
      attachmentFileId: 'f_second',
    }, { turnId: 'turn-2' });
    expect(isSameTooltipPill(first, other)).toBe(false);
  });

  it('scopes composer attachment ids to the concrete editor instance', () => {
    const editor = {} as HTMLElement;
    const attrs = { attachmentId: 'same0001', attachmentKind: 'video', attachmentName: 'demo.mp4' };
    expect(isSameTooltipPill(attachmentPill(attrs, { editor }), attachmentPill(attrs, { editor }))).toBe(true);
    expect(
      isSameTooltipPill(
        attachmentPill(attrs, { editor }),
        attachmentPill(attrs, { editor: {} as HTMLElement }),
      ),
    ).toBe(false);
  });

  it('refuses to reanchor media whose owner cannot be proven', () => {
    const attrs = { attachmentId: 'm1', attachmentKind: 'image', attachmentName: 'shot.png' };
    expect(isSameTooltipPill(attachmentPill(attrs, {}), attachmentPill(attrs, {}))).toBe(false);
  });
});

describe('consumeSelectedMediaEscape', () => {
  it('dismisses the NodeSelection and consumes Escape before it can interrupt the turn', () => {
    const editor = {} as HTMLElement;
    let dismissed: HTMLElement | null = null;
    let prevented = false;
    let stopped = false;
    const selected = {
      closest: (selector: string) => (selector === '.ProseMirror' ? editor : null),
    } as unknown as HTMLElement;

    expect(
      consumeSelectedMediaEscape(
        {
          preventDefault: () => {
            prevented = true;
          },
          stopImmediatePropagation: () => {
            stopped = true;
          },
        },
        selected,
        (root) => {
          dismissed = root;
          return true;
        },
      ),
    ).toBe(true);
    expect(dismissed).toBe(editor);
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
  });

  it('leaves ordinary Escape handling alone when no media pill is selected', () => {
    expect(
      consumeSelectedMediaEscape(
        { preventDefault: () => {}, stopImmediatePropagation: () => {} },
        null,
        () => false,
      ),
    ).toBe(false);
  });
});
