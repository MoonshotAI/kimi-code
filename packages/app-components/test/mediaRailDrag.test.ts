import { describe, expect, it } from 'vitest';
import {
  clampMediaDragTranslate,
  mediaDropIndicatorCenter,
  mediaKeyboardReorderTarget,
  mediaPointerIntent,
} from '../src/composer/mediaRailDrag';

describe('clampMediaDragTranslate', () => {
  it('keeps the dragged item within both ends of the media rail', () => {
    const geometry = {
      draggedStart: 80,
      draggedSize: 64,
      contentStart: 16,
      contentEnd: 304,
    };

    expect(clampMediaDragTranslate({ ...geometry, translate: -200 })).toBe(-64);
    expect(clampMediaDragTranslate({ ...geometry, translate: 80 })).toBe(80);
    expect(clampMediaDragTranslate({ ...geometry, translate: 400 })).toBe(160);
  });

  it('does not move a rail containing only the dragged item', () => {
    expect(clampMediaDragTranslate({
      translate: 100,
      draggedStart: 16,
      draggedSize: 64,
      contentStart: 16,
      contentEnd: 80,
    })).toBe(0);
  });
});

describe('mediaPointerIntent', () => {
  it('keeps mouse clicks pending until movement exceeds four pixels', () => {
    expect(mediaPointerIntent({ pointerType: 'mouse', deltaX: 4, deltaY: 0 })).toBe('pending');
    expect(mediaPointerIntent({ pointerType: 'mouse', deltaX: 5, deltaY: 0 })).toBe('drag');
  });

  it('reserves horizontal touch movement for rail scrolling', () => {
    expect(mediaPointerIntent({ pointerType: 'touch', deltaX: 5, deltaY: 1 })).toBe('scroll');
    expect(mediaPointerIntent({ pointerType: 'touch', deltaX: 1, deltaY: 5 })).toBe('cancel');
  });
});

describe('mediaKeyboardReorderTarget', () => {
  it('prevents browser navigation even when the reorder shortcut hits a boundary', () => {
    let prevented = false;
    expect(mediaKeyboardReorderTarget({
      index: 0,
      length: 3,
      altKey: true,
      key: 'ArrowLeft',
      preventDefault: () => { prevented = true; },
    })).toBeNull();
    expect(prevented).toBe(true);
  });

  it('returns an in-bounds target for a valid reorder shortcut', () => {
    let prevented = false;
    expect(mediaKeyboardReorderTarget({
      index: 1,
      length: 3,
      altKey: true,
      key: 'ArrowRight',
      preventDefault: () => { prevented = true; },
    })).toBe(2);
    expect(prevented).toBe(true);
  });

  it('leaves unrelated keys untouched', () => {
    let prevented = false;
    expect(mediaKeyboardReorderTarget({
      index: 1,
      length: 3,
      altKey: false,
      key: 'ArrowRight',
      preventDefault: () => { prevented = true; },
    })).toBeNull();
    expect(prevented).toBe(false);
  });
});

describe('mediaDropIndicatorCenter', () => {
  const slots = [
    { start: 16, size: 64 },
    { start: 88, size: 64 },
    { start: 160, size: 64 },
  ];

  it('centers internal indicators between adjacent slots', () => {
    expect(mediaDropIndicatorCenter({ targetIndex: 1, contentStart: 0, slots })).toBe(84);
    expect(mediaDropIndicatorCenter({ targetIndex: 2, contentStart: 0, slots })).toBe(156);
  });

  it('centers the leading indicator in the rail inset', () => {
    expect(mediaDropIndicatorCenter({ targetIndex: 0, contentStart: 0, slots })).toBe(8);
  });
});
