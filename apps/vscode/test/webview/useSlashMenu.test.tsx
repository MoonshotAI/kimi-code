import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSlashMenu } from '@/components/inputarea/hooks/useSlashMenu';
import { useSettingsStore } from '@/stores';

const COMMANDS = [
  { name: 'review', description: 'review the diff', aliases: [] },
  { name: 'refactor', description: 'refactor a module', aliases: [] },
  { name: 'release', description: 'cut a release', aliases: [] },
];

const slash = (query: string) => ({ trigger: '/' as const, start: 0, query });

type Token = ReturnType<typeof slash> | null;

const noop = () => {};

beforeEach(() => {
  useSettingsStore.setState({ slashCommands: COMMANDS });
});

function press(result: { current: ReturnType<typeof useSlashMenu> }, key: string) {
  const preventDefault = vi.fn();
  let handled = false;
  act(() => {
    handled = result.current.handleSlashMenuKey({ key, preventDefault } as unknown as React.KeyboardEvent);
  });
  return { handled, preventDefault };
}

describe('selection bounds while the filtered list shrinks', () => {
  it('keeps the selected index inside the list when typing narrows the commands', () => {
    const { result, rerender } = renderHook(({ token }) => useSlashMenu(token, noop, noop, noop), {
      initialProps: { token: slash('re') as Token },
    });
    expect(result.current.filteredCommands).toHaveLength(3);

    press(result, 'ArrowDown');
    press(result, 'ArrowDown');
    expect(result.current.selectedIndex).toBe(2);

    rerender({ token: slash('rev') });
    expect(result.current.filteredCommands).toHaveLength(1);
    expect(result.current.selectedIndex).toBe(0);
  });

  it('completes the visible command on Tab after the list shrinks', () => {
    const onCompleteCommand = vi.fn();
    const { result, rerender } = renderHook(({ token }) => useSlashMenu(token, noop, onCompleteCommand, noop), {
      initialProps: { token: slash('re') as Token },
    });

    press(result, 'ArrowDown');
    press(result, 'ArrowDown');
    rerender({ token: slash('rev') });

    const { handled, preventDefault } = press(result, 'Tab');
    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(onCompleteCommand).toHaveBeenCalledWith('review');
  });

  it('does not restore a stale selection when the list grows again', () => {
    const { result, rerender } = renderHook(({ token }) => useSlashMenu(token, noop, noop, noop), {
      initialProps: { token: slash('re') as Token },
    });

    press(result, 'ArrowDown');
    press(result, 'ArrowDown');
    rerender({ token: slash('rev') });
    expect(result.current.selectedIndex).toBe(0);

    rerender({ token: slash('re') });
    expect(result.current.filteredCommands).toHaveLength(COMMANDS.length);
    expect(result.current.selectedIndex).toBe(0);
  });

  it('selects the visible command on Enter after the list shrinks', () => {
    const onSelectCommand = vi.fn();
    const { result, rerender } = renderHook(({ token }) => useSlashMenu(token, onSelectCommand, noop, noop), {
      initialProps: { token: slash('re') as Token },
    });

    press(result, 'ArrowDown');
    press(result, 'ArrowDown');
    rerender({ token: slash('rev') });

    press(result, 'Enter');
    expect(onSelectCommand).toHaveBeenCalledWith('review');
  });
});

describe('slash menu key handling', () => {
  it('moves the selection within the list bounds with ArrowDown and ArrowUp', () => {
    const { result } = renderHook(() => useSlashMenu(slash('re'), noop, noop, noop));
    expect(result.current.selectedIndex).toBe(0);

    press(result, 'ArrowUp');
    expect(result.current.selectedIndex).toBe(0);

    press(result, 'ArrowDown');
    press(result, 'ArrowDown');
    press(result, 'ArrowDown');
    expect(result.current.selectedIndex).toBe(COMMANDS.length - 1);

    press(result, 'ArrowUp');
    expect(result.current.selectedIndex).toBe(COMMANDS.length - 2);
  });

  it('completes on Tab and selects on Enter', () => {
    const onSelectCommand = vi.fn();
    const onCompleteCommand = vi.fn();
    const { result } = renderHook(() => useSlashMenu(slash('rev'), onSelectCommand, onCompleteCommand, noop));

    press(result, 'Tab');
    expect(onCompleteCommand).toHaveBeenCalledWith('review');
    expect(onSelectCommand).not.toHaveBeenCalled();

    press(result, 'Enter');
    expect(onSelectCommand).toHaveBeenCalledWith('review');
    expect(onCompleteCommand).toHaveBeenCalledTimes(1);
  });

  it('leaves keys unhandled when no command matches', () => {
    const { result } = renderHook(() => useSlashMenu(slash('zzz'), noop, noop, noop));
    expect(result.current.filteredCommands).toHaveLength(0);
    expect(press(result, 'Tab').handled).toBe(false);
  });
});
