import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBundledFont } from '../src/composables/loadBundledFonts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadBundledFont', () => {
  it('fetches the bundled face once its stylesheet is registered', async () => {
    const load = vi.fn(() => Promise.resolve([]));
    vi.stubGlobal('document', { fonts: { load } });
    await loadBundledFont('JetBrains Mono Variable');
    await loadBundledFont('JetBrains Mono Variable');
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('1em "JetBrains Mono Variable"');
  });

  it('resolves when the face fails to load', async () => {
    vi.stubGlobal('document', { fonts: { load: () => Promise.reject(new Error('offline')) } });
    await expect(loadBundledFont('Schibsted Grotesk Variable')).resolves.toBeUndefined();
  });
});
