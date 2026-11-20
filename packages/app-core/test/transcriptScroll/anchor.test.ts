// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createDomAnchors } from '../../src/lib/transcriptScroll';
import { blockRows, LayoutSim } from './layoutSim';

const ROW = 278;

function sim(): LayoutSim {
  const s = new LayoutSim({ rows: blockRows(10), viewport: 400 });
  s.userScroll(ROW * 2 + 100);
  return s;
}

describe('createDomAnchors.pick', () => {
  it('picks the deepest candidate crossing the viewport top with a negative offset', () => {
    const s = sim();
    const anchors = createDomAnchors(s.scroller);
    const picked = anchors.pick(s.clientTop)!;
    expect(picked.path).toEqual({ row: 'r2', block: 'md', child: 1 });
    expect(picked.el).toBe(s.childEl('r2', 'md', 1));
    expect(picked.offset).toBe(-22);
  });

  it('stops at blocks without markdown and at the row gap', () => {
    const s = sim();
    const anchors = createDomAnchors(s.scroller);
    s.userScroll(ROW * 2 + 20);
    expect(anchors.pick(s.clientTop)).toMatchObject({ path: { row: 'r2', block: 'head' }, offset: -12 });
    s.userScroll(ROW * 2 + 3);
    expect(anchors.pick(s.clientTop)).toMatchObject({ path: { row: 'r2' }, offset: -3 });
  });

  it('returns only the row when asked', () => {
    const s = sim();
    expect(createDomAnchors(s.scroller).pick(s.clientTop, { rowOnly: true })).toMatchObject({ path: { row: 'r2' }, offset: -100 });
  });

  it('falls back to the first row below when the top is over unmounted space', () => {
    const s = sim();
    s.unmount('r2');
    s.unmount('r3');
    s.frame();
    s.userScroll(ROW * 2 + 100);
    const picked = createDomAnchors(s.scroller).pick(s.clientTop)!;
    expect(picked.path).toEqual({ row: 'r4' });
    expect(picked.offset).toBe(ROW * 2 - 100);
  });

  it('returns null without rows', () => {
    const s = new LayoutSim({ rows: [], viewport: 400 });
    expect(createDomAnchors(s.scroller).pick(s.clientTop)).toBeNull();
  });
});

describe('createDomAnchors.resolve', () => {
  it('falls back from child to block to row, and to null for unmounted rows', () => {
    const s = sim();
    const anchors = createDomAnchors(s.scroller);
    expect(anchors.resolve({ row: 'r2', block: 'md', child: 3 })).toBe(s.childEl('r2', 'md', 3));
    expect(anchors.resolve({ row: 'r2', block: 'md', child: 9 })).toBe(s.blockEl('r2', 'md'));
    expect(anchors.resolve({ row: 'r2', block: 'gone', child: 1 })).toBe(s.rowEl('r2'));
    expect(anchors.resolve({ row: 'r2' })).toBe(s.rowEl('r2'));
    s.unmount('r2');
    expect(anchors.resolve({ row: 'r2', block: 'md', child: 1 })).toBeNull();
  });

  it('re-resolves markdown children after they are replaced', () => {
    const s = sim();
    const anchors = createDomAnchors(s.scroller);
    const path = anchors.pick(s.clientTop)!.path;
    const before = anchors.resolve(path)!;
    s.replaceMarkdown('r2', 'md');
    const after = anchors.resolve(path)!;
    expect(before.isConnected).toBe(false);
    expect(after).not.toBe(before);
    expect(after).toBe(s.childEl('r2', 'md', 1));
  });
});

describe('createDomAnchors.pathOf', () => {
  it('describes elements by row, block and markdown child', () => {
    const s = sim();
    const anchors = createDomAnchors(s.scroller);
    const inner = document.createElement('span');
    s.childEl('r4', 'md', 2).append(inner);
    expect(anchors.pathOf(inner)).toEqual({ row: 'r4', block: 'md', child: 2 });
    expect(anchors.pathOf(s.blockEl('r4', 'head'))).toEqual({ row: 'r4', block: 'head' });
    expect(anchors.pathOf(s.rowEl('r4'))).toEqual({ row: 'r4' });
    expect(anchors.pathOf(s.dockEl)).toBeNull();
  });
});
