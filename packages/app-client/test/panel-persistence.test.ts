import { describe, expect, it, vi } from 'vitest';
import { readPanelSnapshot, writePanelSnapshot, type StoredPanelSnapshot } from '../src/panel/panelPersistence';

const snapshot: StoredPanelSnapshot = {
  tabs: [{ type: 'file', payload: { path: '/new.md', content: 'preview' } }, { type: 'diff', payload: {} }],
  activeIndex: 1, visible: true, expanded: false,
};

function memoryStorage(maxLength = Infinity) {
  const values = new Map<string, string>();
  return { values, get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      if (value.length > maxLength) throw new Error('QuotaExceededError');
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
}

describe('bounded panel snapshots', () => {
  it('retains tab identity and selection without serializing large inline files', () => {
    const storage = memoryStorage();
    const large = { ...snapshot, tabs: [{ type: 'file' as const, payload: { path: '/large.md', line: 5, content: 'x'.repeat(100_000) } }, snapshot.tabs[1]!] };
    writePanelSnapshot(storage, 'session', large);
    expect(readPanelSnapshot(storage, 'session')).toEqual({ ...large, tabs: [{ type: 'file', payload: { path: '/large.md', line: 5 } }, snapshot.tabs[1]] });
    expect(storage.setItem.mock.calls[0]![1].length).toBeLessThan(1024);
  });

  it('bounds combined inline content across many individually small files', () => {
    const storage = memoryStorage();
    writePanelSnapshot(storage, 'session', { ...snapshot, tabs: Array.from({ length: 10 }, (_, index) => ({ type: 'file', payload: { path: `/${index}`, content: 'x'.repeat(64 * 1024) } })) });
    const restored = readPanelSnapshot(storage, 'session')!;
    expect(restored.tabs).toHaveLength(10);
    expect(restored.tabs.filter(tab => (tab.payload as { content?: string }).content !== undefined)).toHaveLength(4);
  });

  it('replaces stale state with content-free descriptors when the origin quota is exhausted', () => {
    const storage = memoryStorage(300);
    storage.values.set('kimi-web.panel-tabs.v1:session', JSON.stringify({ ...snapshot, tabs: [{ type: 'file', payload: { path: '/closed.md' } }] }));
    writePanelSnapshot(storage, 'session', { ...snapshot, tabs: [{ type: 'file', payload: { path: '/new.md', content: 'x'.repeat(1000) } }, snapshot.tabs[1]!] });
    expect(readPanelSnapshot(storage, 'session')).toEqual({ ...snapshot, tabs: [{ type: 'file', payload: { path: '/new.md' } }, snapshot.tabs[1]] });
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it('removes stale state if even minimal descriptors cannot be written', () => {
    const storage = memoryStorage(1);
    storage.values.set('kimi-web.panel-tabs.v1:session', 'old state');
    writePanelSnapshot(storage, 'session', snapshot);
    expect(storage.values.size).toBe(0);
  });

});


it('limits compaction text without dropping unrelated tab descriptors', () => {
  const storage = memoryStorage();
  const tabs: StoredPanelSnapshot['tabs'] = [
    { type: 'compaction', payload: { turnId: 'turn-1', text: 'x'.repeat(100_000) } },
    { type: 'term', payload: { title: 'zsh', cwd: '/work' } },
    ...snapshot.tabs,
  ];
  writePanelSnapshot(storage, 'session', { ...snapshot, tabs });
  const restored = readPanelSnapshot(storage, 'session')!;
  expect(restored.tabs).toHaveLength(4);
  expect(restored.tabs[0]).toEqual({ type: 'compaction', payload: { turnId: 'turn-1' } });
  expect(restored.activeIndex).toBe(1);
  expect(storage.setItem.mock.calls[0]![1].length).toBeLessThan(1024);
});

it('removes both file and compaction bodies on a quota retry', () => {
  const storage = memoryStorage(400);
  const tabs: StoredPanelSnapshot['tabs'] = [
    { type: 'compaction', payload: { turnId: 'turn-1', text: 'x'.repeat(1000) } },
    ...snapshot.tabs,
  ];
  writePanelSnapshot(storage, 'session', { ...snapshot, tabs });
  expect(readPanelSnapshot(storage, 'session')).toEqual({ ...snapshot, tabs: [
    { type: 'compaction', payload: { turnId: 'turn-1' } },
    { type: 'file', payload: { path: '/new.md' } },
    snapshot.tabs[1],
  ] });
  expect(storage.setItem).toHaveBeenCalledTimes(2);
});

it('bounds all contexts while preserving unrelated storage and newest descriptors', () => {
  const storage = memoryStorage();
  storage.values.set('other-feature', 'keep');
  for (let index = 0; index < 150; index += 1) {
    writePanelSnapshot(storage, `session-${index}`, { ...snapshot, tabs: [{ type: 'file', payload: { path: '/file', content: 'x'.repeat(64 * 1024) } }] });
  }
  expect([...storage.values].reduce((sum, [key, value]) => sum + key.length + value.length, 0)).toBeLessThan(1024 * 1024 + 100);
  expect(storage.values.size).toBeLessThanOrEqual(101);
  expect(storage.values.get('other-feature')).toBe('keep');
  expect(readPanelSnapshot(storage, 'session-149')?.tabs).toHaveLength(1);
  expect(readPanelSnapshot(storage, 'session-0')).toBeUndefined();
});

it('reclaims old panel keys when unrelated data leaves little origin quota', () => {
  const storage = memoryStorage();
  storage.setItem.mockImplementation((key, value) => {
    const size = [...storage.values].filter(([existing]) => existing !== key).reduce((sum, [, raw]) => sum + raw.length, value.length);
    if (size > 700) throw new Error('QuotaExceededError');
    storage.values.set(key, value);
  });
  storage.values.set('unrelated', 'x'.repeat(300));
  storage.values.set('kimi-web.panel-tabs.v1:old', 'x'.repeat(300));
  writePanelSnapshot(storage, 'new', snapshot);
  expect(readPanelSnapshot(storage, 'new')?.tabs).toHaveLength(2);
  expect(storage.values.has('kimi-web.panel-tabs.v1:old')).toBe(false);
  expect(storage.values.has('unrelated')).toBe(true);
});

it('caps the number of small snapshots', () => {
  const storage = memoryStorage();
  for (let index = 0; index < 150; index += 1) writePanelSnapshot(storage, `small-${index}`, snapshot);
  expect(storage.values.size).toBe(100);
  expect(readPanelSnapshot(storage, 'small-149')).toEqual(snapshot);
});
