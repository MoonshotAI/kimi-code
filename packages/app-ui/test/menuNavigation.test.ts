import { describe, expect, it } from 'vitest';
import { menuNavigationIndex } from '../src/composables/menuNavigation';

describe('menu navigation', () => {
  it('wraps at both ends and supports tab direction', () => {
    expect(menuNavigationIndex('ArrowDown', false, 2, 3)).toBe(0);
    expect(menuNavigationIndex('ArrowUp', false, 0, 3)).toBe(2);
    expect(menuNavigationIndex('Tab', false, 2, 3)).toBe(0);
    expect(menuNavigationIndex('Tab', true, 0, 3)).toBe(2);
  });
  it('keeps arrow direction independent of shift and supports endpoints', () => {
    expect(menuNavigationIndex('ArrowDown', true, 0, 3)).toBe(1);
    expect(menuNavigationIndex('ArrowUp', true, 2, 3)).toBe(1);
    expect(menuNavigationIndex('Home', true, 2, 3)).toBe(0);
    expect(menuNavigationIndex('End', false, 0, 3)).toBe(2);
  });
  it('handles no focused item, empty menus and unrelated keys', () => {
    expect(menuNavigationIndex('ArrowDown', false, -1, 3)).toBe(0);
    expect(menuNavigationIndex('ArrowUp', false, -1, 4)).toBe(3);
    expect(menuNavigationIndex('Tab', true, -1, 4)).toBe(3);
    expect(menuNavigationIndex('ArrowUp', false, -1, 1)).toBe(0);
    expect(menuNavigationIndex('ArrowDown', false, -1, 0)).toBe(-1);
    expect(menuNavigationIndex('Escape', false, 0, 3)).toBeNull();
    expect(menuNavigationIndex('Enter', false, 0, 3)).toBeNull();
  });
});
