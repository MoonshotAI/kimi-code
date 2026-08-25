// packages/app-composer/test/mention-selection-sync.test.ts
// The selection-paint sync must cover quote pills too: the query set drives
// which pills under a root get `.pill-in-selection` — a selector missing
// `.quote-pill` leaves quote pills unpainted when a selection crosses them.
// DOM-free: the document/selection/range surface is stubbed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMentionSelectionSync } from '../src/mentionSelectionSync';

class FakeNode {}

interface FakeClassList {
  added: string[];
  removed: string[];
}

function fakePill(): { classList: FakeClassList & { add(c: string): void; remove(c: string): void } } {
  const classList: FakeClassList & { add(c: string): void; remove(c: string): void } = {
    added: [],
    removed: [],
    add(c: string) {
      this.added.push(c);
    },
    remove(c: string) {
      this.removed.push(c);
    },
  };
  return { classList };
}

describe('startMentionSelectionSync', () => {
  let listener: (() => void) | null = null;
  let savedDocument: unknown;
  let savedNode: unknown;

  beforeEach(() => {
    listener = null;
    savedDocument = (globalThis as { document?: unknown }).document;
    savedNode = (globalThis as { Node?: unknown }).Node;
    (globalThis as { Node?: unknown }).Node = FakeNode;
    (globalThis as { document?: unknown }).document = {
      addEventListener: (_type: string, fn: () => void) => {
        listener = fn;
      },
      removeEventListener: () => {},
    };
  });

  afterEach(() => {
    (globalThis as { document?: unknown }).document = savedDocument;
    (globalThis as { Node?: unknown }).Node = savedNode;
  });

  it('queries quote pills too and marks the covered one', () => {
    const covered = fakePill();
    const uncovered = fakePill();
    const range = { intersectsNode: (node: unknown) => node === root || node === covered };
    let selector = '';
    const root = new FakeNode() as unknown as {
      ownerDocument: unknown;
      querySelectorAll: (sel: string) => unknown[];
    };
    root.ownerDocument = {
      getSelection: () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range }),
    };
    root.querySelectorAll = (sel: string) => {
      selector = sel;
      return [covered, uncovered];
    };

    const stop = startMentionSelectionSync(() => root as unknown as ParentNode);
    expect(listener).not.toBeNull();
    listener!();

    expect(selector).toContain('.quote-pill');
    expect(covered.classList.added).toContain('pill-in-selection');
    expect(uncovered.classList.added).toEqual([]);
    stop();
  });
});
