import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ faces: new Map<string, { blob: () => Promise<Blob> }>() }));
vi.mock('@moonshot-ai/app-core', () => ({ getLocalFontFace: (family: string) => fixture.faces.get(family) }));
vi.mock('@moonshot-ai/app-core/lib', () => ({ readFontMetadata: async () => ({ names: [{ id: 1, language: 'en', text: 'Read' }] }) }));

describe('font metadata queue', () => {
  it('limits concurrency, prioritizes visible faces, caches results, and survives a failed font', async () => {
    vi.resetModules();
    const started: string[] = [];
    const release = new Map<string, (blob: Blob) => void>();
    for (const family of ['A', 'B', 'C', 'D']) {
      fixture.faces.set(family, { blob: () => {
        started.push(family);
        return new Promise<Blob>((resolve) => release.set(family, resolve));
      } });
    }
    fixture.faces.set('Broken', { blob: async () => { throw new Error('Unreadable font'); } });
    const { ensureFontMetadata, fontMetadata } = (await import('../src/composables/useFontMetadata')).useFontMetadata();
    const a = ensureFontMetadata('A', false);
    const b = ensureFontMetadata('B', false);
    const c = ensureFontMetadata('C', false);
    const d = ensureFontMetadata('D', false);
    expect(started).toEqual(['A', 'B']);
    expect(ensureFontMetadata('A')).toBe(a);
    expect(ensureFontMetadata('D')).toBe(d);
    release.get('A')!(new Blob());
    await a;
    await vi.waitFor(() => expect(started).toEqual(['A', 'B', 'D']));
    release.get('B')!(new Blob());
    await b;
    await vi.waitFor(() => expect(started).toEqual(['A', 'B', 'D', 'C']));
    release.get('C')!(new Blob()); release.get('D')!(new Blob());
    await Promise.all([c, d]);
    await ensureFontMetadata('Broken');
    expect(fontMetadata.value['Broken']?.status).toBe('unavailable');
    expect(fontMetadata.value['D']?.metadata?.names[0]?.text).toBe('Read');
    await ensureFontMetadata('A');
    expect(started.filter((family) => family === 'A')).toHaveLength(1);
  });
  it('drops a queued preview read once its row is released, but never a kept or started read', async () => {
    vi.resetModules();
    const started: string[] = [];
    const release = new Map<string, (blob: Blob) => void>();
    for (const family of ['P1', 'P2', 'Gone', 'Kept']) {
      fixture.faces.set(family, { blob: () => {
        started.push(family);
        return new Promise<Blob>((resolve) => release.set(family, resolve));
      } });
    }
    const { ensureFontMetadata, previewFontMetadata, releaseFontMetadata, fontMetadata } =
      (await import('../src/composables/useFontMetadata')).useFontMetadata();
    const p1 = previewFontMetadata('P1');
    const p2 = previewFontMetadata('P2');
    const gone = previewFontMetadata('Gone');
    const kept = ensureFontMetadata('Kept', false);
    expect(started).toEqual(['P1', 'P2']);
    releaseFontMetadata('Gone');
    releaseFontMetadata('Kept');
    releaseFontMetadata('P1');
    await gone;
    expect(fontMetadata.value['Gone']).toBeUndefined();
    release.get('P1')!(new Blob());
    release.get('P2')!(new Blob());
    await Promise.all([p1, p2]);
    await vi.waitFor(() => expect(started).toEqual(['P1', 'P2', 'Kept']));
    release.get('Kept')!(new Blob());
    await kept;
    expect(fontMetadata.value['P1']?.status).toBe('ready');
    expect(fontMetadata.value['Kept']?.status).toBe('ready');
    const again = previewFontMetadata('Gone');
    await vi.waitFor(() => expect(started).toContain('Gone'));
    release.get('Gone')!(new Blob());
    await again;
    expect(fontMetadata.value['Gone']?.status).toBe('ready');
  });

});
