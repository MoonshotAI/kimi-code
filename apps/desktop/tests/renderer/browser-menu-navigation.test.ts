import { expect, it, vi } from 'vitest';
import { nextBrowserMenuIndex, revealBrowserMenuSelection } from '../../src/renderer/lib/browserMenuNavigation';

it.each([1, 2, 8])('enters a %s-item menu from the appropriate edge and wraps', (count) => {
  expect(nextBrowserMenuIndex(-1, count, 1)).toBe(0);
  expect(nextBrowserMenuIndex(-1, count, -1)).toBe(count - 1);
  expect(nextBrowserMenuIndex(0, count, -1)).toBe(count - 1);
  expect(nextBrowserMenuIndex(count - 1, count, 1)).toBe(0);
});

it('does not select an item in an empty menu', () => {
  expect(nextBrowserMenuIndex(-1, 0, 1)).toBe(-1);
  expect(nextBrowserMenuIndex(-1, 0, -1)).toBe(-1);
});

it('reveals the selected listbox option without moving input focus', () => {
  const selected = { scrollIntoView: vi.fn(), focus: vi.fn() };
  const menu = { querySelector: vi.fn(() => selected) };
  revealBrowserMenuSelection(menu as unknown as HTMLElement);
  expect(menu.querySelector).toHaveBeenCalledWith('[role="option"][aria-selected="true"]');
  expect(selected.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  expect(selected.focus).not.toHaveBeenCalled();
  expect(() => revealBrowserMenuSelection(undefined)).not.toThrow();
});
