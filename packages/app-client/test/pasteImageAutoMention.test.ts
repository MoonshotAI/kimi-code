import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'kimi-web.paste-image-auto-mention';

function stubStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  });
  return map;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('usePasteImageAutoMention', () => {
  it('defaults OFF when storage is empty', async () => {
    stubStorage();
    const { usePasteImageAutoMention } = await import('../src/composables/usePasteImageAutoMention');
    expect(usePasteImageAutoMention().pasteImageAutoMention.value).toBe(false);
  });

  it("reads only an exact '1' as ON", async () => {
    stubStorage({ [KEY]: '1' });
    const { usePasteImageAutoMention } = await import('../src/composables/usePasteImageAutoMention');
    expect(usePasteImageAutoMention().pasteImageAutoMention.value).toBe(true);
  });

  it.each(['0', 'true', '01', ' 1', '1 ', 'yes'])('keeps OFF for stored value %j', async (value) => {
    stubStorage({ [KEY]: value });
    const { usePasteImageAutoMention } = await import('../src/composables/usePasteImageAutoMention');
    expect(usePasteImageAutoMention().pasteImageAutoMention.value).toBe(false);
  });

  it('shares the setting and persists it across a reload', async () => {
    const map = stubStorage({ 'kimi-web.draft.s1': 'keep this draft' });
    const first = await import('../src/composables/usePasteImageAutoMention');
    const one = first.usePasteImageAutoMention();
    const two = first.usePasteImageAutoMention();
    one.setPasteImageAutoMention(true);
    expect(two.pasteImageAutoMention.value).toBe(true);
    expect(map.get(KEY)).toBe('1');
    expect(map.get('kimi-web.draft.s1')).toBe('keep this draft');

    vi.resetModules();
    const reloaded = await import('../src/composables/usePasteImageAutoMention');
    expect(reloaded.usePasteImageAutoMention().pasteImageAutoMention.value).toBe(true);
    reloaded.usePasteImageAutoMention().setPasteImageAutoMention(false);
    expect(map.get(KEY)).toBe('0');
    expect(map.get('kimi-web.draft.s1')).toBe('keep this draft');
  });

  it('stays OFF after a reload when storage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    const first = await import('../src/composables/usePasteImageAutoMention');
    expect(first.usePasteImageAutoMention().pasteImageAutoMention.value).toBe(false);
    expect(() => first.usePasteImageAutoMention().setPasteImageAutoMention(true)).not.toThrow();

    vi.resetModules();
    const reloaded = await import('../src/composables/usePasteImageAutoMention');
    expect(reloaded.usePasteImageAutoMention().pasteImageAutoMention.value).toBe(false);
  });
});
