import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFilePicker } from '@/components/inputarea/hooks/useFilePicker';
import { useChatStore } from '@/stores';

const getProjectFiles = vi.fn();

vi.mock('@/services', () => ({
  bridge: {
    getProjectFiles: (...args: unknown[]) => getProjectFiles(...args),
  },
}));

const noop = () => {};
const at = (query: string) => ({ trigger: '@' as const, start: 0, query });

type Token = ReturnType<typeof at> | null;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  getProjectFiles.mockReset();
  getProjectFiles.mockResolvedValue([]);
  useChatStore.setState({ isStreaming: false, draftMedia: [] });
});

describe('enabled gating', () => {
  it('does not search without an active token', async () => {
    renderHook(() => useFilePicker(null, noop, noop, noop), { wrapper: createWrapper() });
    await new Promise((r) => setTimeout(r, 150));
    expect(getProjectFiles).not.toHaveBeenCalled();
  });
});

describe('search', () => {
  it('searches with the current query and returns results', async () => {
    getProjectFiles.mockResolvedValue([{ name: 'app.ts', path: 'src/app.ts', isDirectory: false }]);
    const { result } = renderHook(() => useFilePicker(at('app'), noop, noop, noop), { wrapper: createWrapper() });
    await waitFor(() => { expect(result.current.fileItems).toHaveLength(1); });
    expect(result.current.fileItems[0]).toMatchObject({ name: 'app.ts', path: 'src/app.ts' });
  });

  it('caps the displayed items at 50', async () => {
    getProjectFiles.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.ts`, path: `f${i}.ts`, isDirectory: false })),
    );
    const { result } = renderHook(() => useFilePicker(at('f'), noop, noop, noop), { wrapper: createWrapper() });
    await waitFor(() => { expect(result.current.fileItems).toHaveLength(50); });
  });

  it('debounces rapid query changes into a single request after 100ms', async () => {
    const { rerender } = renderHook(({ token }) => useFilePicker(token, noop, noop, noop), {
      initialProps: { token: at('') as Token },
      wrapper: createWrapper(),
    });
    await waitFor(() => { expect(getProjectFiles).toHaveBeenCalledTimes(1); });
    getProjectFiles.mockClear();

    rerender({ token: at('a') });
    rerender({ token: at('ap') });
    rerender({ token: at('app') });
    expect(getProjectFiles).not.toHaveBeenCalled();

    await waitFor(() => { expect(getProjectFiles).toHaveBeenCalledTimes(1); });
    expect(getProjectFiles).toHaveBeenCalledWith({ query: 'app' });
  });
});

describe('media option', () => {
  it('shows the media option only for an empty query', async () => {
    const { result, rerender } = renderHook(({ token }) => useFilePicker(token, noop, noop, noop), {
      initialProps: { token: at('') as Token },
      wrapper: createWrapper(),
    });
    expect(result.current.showMediaOption).toBe(true);
    expect(result.current.fileMenuHeaderCount).toBe(1);

    rerender({ token: at('a') });
    expect(result.current.showMediaOption).toBe(false);
    expect(result.current.fileMenuHeaderCount).toBe(0);
  });

  it('hides the media option when media cannot be added', () => {
    useChatStore.setState({ isStreaming: true });
    const { result } = renderHook(() => useFilePicker(at(''), noop, noop, noop), { wrapper: createWrapper() });
    expect(result.current.showMediaOption).toBe(false);
    expect(result.current.fileMenuHeaderCount).toBe(0);
  });
});

describe('keyboard navigation', () => {
  const key = (result: { current: ReturnType<typeof useFilePicker> }, k: string) => {
    act(() => {
      result.current.handleFileMenuKey({ key: k, preventDefault: vi.fn() } as unknown as React.KeyboardEvent);
    });
  };

  it('moves selectedIndex within the list bounds with ArrowDown and ArrowUp', async () => {
    getProjectFiles.mockResolvedValue([
      { name: 'a.ts', path: 'a.ts', isDirectory: false },
      { name: 'b.ts', path: 'b.ts', isDirectory: false },
    ]);
    const { result } = renderHook(() => useFilePicker(at('a'), noop, noop, noop), { wrapper: createWrapper() });
    await waitFor(() => { expect(result.current.fileItems).toHaveLength(2); });

    const maxIndex = result.current.fileMenuHeaderCount + result.current.fileItems.length - 1;
    expect(result.current.selectedIndex).toBe(0);
    key(result, 'ArrowUp');
    expect(result.current.selectedIndex).toBe(0);
    key(result, 'ArrowDown');
    key(result, 'ArrowDown');
    key(result, 'ArrowDown');
    expect(result.current.selectedIndex).toBe(maxIndex);
    key(result, 'ArrowUp');
    expect(result.current.selectedIndex).toBe(maxIndex - 1);
  });

  it('lets Enter fall through when there is no selectable entry', async () => {
    getProjectFiles.mockResolvedValue([]);
    const { result } = renderHook(() => useFilePicker(at('zzz'), noop, noop, noop), { wrapper: createWrapper() });
    await waitFor(() => { expect(result.current.isLoading).toBe(false); });

    let handled = true;
    act(() => {
      handled = result.current.handleFileMenuKey({ key: 'Enter', preventDefault: vi.fn() } as unknown as React.KeyboardEvent);
    });
    expect(handled).toBe(false);
  });

  it('clamps the selection when fresh results shrink the list', async () => {
    getProjectFiles.mockResolvedValue([
      { name: 'a.ts', path: 'a.ts', isDirectory: false },
      { name: 'b.ts', path: 'b.ts', isDirectory: false },
    ]);
    const { result, rerender } = renderHook(({ token }) => useFilePicker(token, noop, noop, noop), {
      initialProps: { token: at('a') as Token },
      wrapper: createWrapper(),
    });
    await waitFor(() => { expect(result.current.fileItems).toHaveLength(2); });

    getProjectFiles.mockResolvedValue([{ name: 'app.ts', path: 'app.ts', isDirectory: false }]);
    rerender({ token: at('ap') });
    act(() => { result.current.setSelectedIndex(1); });
    await waitFor(() => { expect(result.current.fileItems).toHaveLength(1); });
    expect(result.current.selectedIndex).toBe(0);
  });

  it('calls onPickMedia when Enter selects the media option', async () => {
    const onPickMedia = vi.fn();
    const { result } = renderHook(() => useFilePicker(at(''), noop, onPickMedia, noop), { wrapper: createWrapper() });

    expect(result.current.selectedIndex).toBe(0);
    key(result, 'Enter');
    expect(onPickMedia).toHaveBeenCalledTimes(1);
  });

  it('ignores confirmation while results are stale for the current query', async () => {
    getProjectFiles.mockResolvedValue([{ name: 'a.ts', path: 'src/a.ts', isDirectory: false }]);
    const onInsertFile = vi.fn();
    const { result, rerender } = renderHook(({ token }) => useFilePicker(token, onInsertFile, noop, noop), {
      initialProps: { token: at('a') as Token },
      wrapper: createWrapper(),
    });
    await waitFor(() => { expect(result.current.fileItems).toHaveLength(1); });

    let resolveNext: (value: unknown) => void = noop;
    getProjectFiles.mockImplementation(() => new Promise((resolve) => { resolveNext = resolve; }));
    rerender({ token: at('ap') });
    expect(result.current.isStale).toBe(true);

    key(result, 'Enter');
    act(() => { result.current.handleSelectItem(result.current.fileItems[0]!); });
    expect(onInsertFile).not.toHaveBeenCalled();

    await waitFor(() => { expect(getProjectFiles).toHaveBeenCalledWith({ query: 'ap' }); });
    act(() => { resolveNext([{ name: 'app.ts', path: 'src/app.ts', isDirectory: false }]); });
    await waitFor(() => { expect(result.current.fileItems[0]?.name).toBe('app.ts'); });
    expect(result.current.isStale).toBe(false);

    key(result, 'Enter');
    expect(onInsertFile).toHaveBeenCalledWith('src/app.ts');
  });

  it('calls onInsertFile when Enter selects a file', async () => {
    getProjectFiles.mockResolvedValue([{ name: 'a.ts', path: 'src/a.ts', isDirectory: false }]);
    const onInsertFile = vi.fn();
    const { result } = renderHook(() => useFilePicker(at('a'), onInsertFile, noop, noop), { wrapper: createWrapper() });
    await waitFor(() => { expect(result.current.fileItems).toHaveLength(1); });

    act(() => {
      result.current.setSelectedIndex(result.current.fileMenuHeaderCount);
    });
    key(result, 'Enter');
    expect(onInsertFile).toHaveBeenCalledWith('src/a.ts');
  });

  it('calls onInsertFile with the directory path when Enter selects a directory', async () => {
    getProjectFiles.mockResolvedValue([{ name: 'src', path: 'src', isDirectory: true }]);
    const onInsertFile = vi.fn();
    const { result } = renderHook(() => useFilePicker(at('sr'), onInsertFile, noop, noop), { wrapper: createWrapper() });
    await waitFor(() => { expect(result.current.fileItems).toHaveLength(1); });

    act(() => {
      result.current.setSelectedIndex(result.current.fileMenuHeaderCount);
    });
    key(result, 'Enter');
    expect(onInsertFile).toHaveBeenCalledWith('src');
  });
});
