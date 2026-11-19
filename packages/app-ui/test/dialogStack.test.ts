import { describe, expect, it } from 'vitest';

import {
  openDialogCount,
  pushDialog,
  removeDialog,
  topDialogId,
} from '../src/composables/dialogStack';

describe('dialogStack', () => {
  it('tracks the topmost dialog in push order', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    expect(topDialogId.value).toBeUndefined();
    pushDialog(a);
    expect(topDialogId.value).toBe(a);
    pushDialog(b);
    expect(topDialogId.value).toBe(b);
    expect(openDialogCount.value).toBe(2);
    removeDialog(b);
    expect(topDialogId.value).toBe(a);
    removeDialog(a);
    expect(topDialogId.value).toBeUndefined();
    expect(openDialogCount.value).toBe(0);
  });

  it('promotes the remaining dialog when a middle entry is removed', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    const c = Symbol('c');
    pushDialog(a);
    pushDialog(b);
    pushDialog(c);
    removeDialog(c);
    removeDialog(b);
    expect(topDialogId.value).toBe(a);
    removeDialog(a);
    expect(openDialogCount.value).toBe(0);
  });

  it('ignores removing an id that was never pushed', () => {
    const a = Symbol('a');
    const before = openDialogCount.value;
    pushDialog(a);
    removeDialog(Symbol('stray'));
    expect(topDialogId.value).toBe(a);
    expect(openDialogCount.value).toBe(before + 1);
    removeDialog(a);
  });
});
