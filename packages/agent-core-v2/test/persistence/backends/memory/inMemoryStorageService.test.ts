import { describe, expect, it } from 'vitest';

import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

const encoder = new TextEncoder();

describe('InMemoryStorageService — mtime', () => {
  it('returns undefined for a missing key and the write time for an existing one', async () => {
    const svc = new InMemoryStorageService();
    expect(await svc.mtime('scope', 'missing.json')).toBeUndefined();

    const before = Date.now();
    await svc.write('scope', 'k.json', encoder.encode('{}'));
    const mtime = await svc.mtime('scope', 'k.json');
    expect(mtime).toBeGreaterThanOrEqual(before);
  });

  it('tracks writes, appends and deletions', async () => {
    const svc = new InMemoryStorageService();

    await svc.write('scope', 'k.json', encoder.encode('a'));
    const written = await svc.mtime('scope', 'k.json');
    expect(written).toBeDefined();

    await svc.append('scope', 'k.json', encoder.encode('b'));
    const appended = await svc.mtime('scope', 'k.json');
    expect(appended).toBeGreaterThanOrEqual(written ?? 0);

    await svc.delete('scope', 'k.json');
    expect(await svc.mtime('scope', 'k.json')).toBeUndefined();
  });
});
