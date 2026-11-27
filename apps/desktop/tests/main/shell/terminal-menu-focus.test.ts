import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('terminal menu focus state', () => {
  it('starts unfocused and notifies subscribers in registration order on change only', async () => {
    const { getTerminalMenuFocus, onTerminalMenuFocus, setTerminalMenuFocus } = await import('../../../src/main/shell/terminal-menu-focus');
    const calls: string[] = [];
    onTerminalMenuFocus((focused) => calls.push(`menu:${focused}`));
    onTerminalMenuFocus((focused) => calls.push(`shortcut:${focused}`));

    expect(getTerminalMenuFocus()).toBe(false);
    setTerminalMenuFocus(false);
    expect(calls).toEqual([]);

    setTerminalMenuFocus(true);
    expect(getTerminalMenuFocus()).toBe(true);
    expect(calls).toEqual(['menu:true', 'shortcut:true']);

    setTerminalMenuFocus(true);
    expect(calls).toHaveLength(2);

    setTerminalMenuFocus(false);
    expect(getTerminalMenuFocus()).toBe(false);
    expect(calls).toEqual(['menu:true', 'shortcut:true', 'menu:false', 'shortcut:false']);
  });
});
