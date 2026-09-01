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

describe('search and folder modes', () => {
  it('loads the given directory in folder mode', async () => {
    const { result } = renderHook(() => useFilePicker(at(''), noop, noop, noop), { wrapper: createWrapper() });
    await waitFor(() => { expect(getProjectFiles).toHaveBeenCalledTimes(1); });

    act(() => {
      result.current.setFilePickerMode('folder');
      result.current.setFolderPath('src');
    });
    await waitFor(() => { expect(getProjectFiles).toHaveBeenCalledWith({ directory: 'src' }); });
  });

  it('shows directory contents in folder mode', async () => {
    getProjectFiles.mockImplementation((params?: { directory?: string }) =>
      Promise.resolve(params?.directory ? [{ name: 'index.ts', path: 'src/index.ts', isDirectory: false }] : []),
    );
    const { result } = renderHook(() => useFilePicker(at(''), noop, noop, noop), { wrapper: createWrapper() });
    await waitFor(() => { expect(getProjectFiles).toHaveBeenCalled(); });

    act(() => {
      result.current.setFilePickerMode('folder');
      result.current.setFolderPath('src');
    });
    await waitFor(() => { expect(result.current.fileItems).toEqual([{ name: 'index.ts', path: 'src/index.ts', isDirectory: false }]); });
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

  it('enters folder mode when Enter selects a directory', async () => {
    getProjectFiles.mockImplementation((params?: { query?: string }) =>
      Promise.resolve(params?.query ? [{ name: 'src', path: 'src', isDirectory: true }] : []),
    );
    const { result } = renderHook(() => useFilePicker(at('sr'), noop, noop, noop), { wrapper: createWrapper() });
    await waitFor(() => { expect(result.current.fileItems).toHaveLength(1); });

    act(() => {
      result.current.setSelectedIndex(result.current.fileMenuHeaderCount);
    });
    key(result, 'Enter');
    expect(result.current.filePickerMode).toBe('folder');
    expect(result.current.folderPath).toBe('src');
    await waitFor(() => { expect(getProjectFiles).toHaveBeenCalledWith({ directory: 'src' }); });
  });
});
