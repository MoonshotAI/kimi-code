import { isBrowserReferenceId } from '@moonshot-ai/app-core/browser-reference';

export function collectStoredBrowserAssetIds(storage: Storage): string[] {
  const retained = new Set<string>();
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key === null) throw new Error('Storage changed during collection');
    const raw = storage.getItem(key);
    if (raw === null) throw new Error('Storage changed during collection');
    if (!raw.includes('browserAssetId')) continue;
    const pending: unknown[] = [JSON.parse(raw)];
    while (pending.length > 0) {
      const value = pending.pop();
      if (value === null || typeof value !== 'object') continue;
      for (const [field, item] of Object.entries(value)) {
        if (field === 'browserAssetId' && isBrowserReferenceId(item)) retained.add(item);
        else if (item !== null && typeof item === 'object') pending.push(item);
      }
    }
  }
  if (retained.size > 100000) throw new Error('Too many retained browser assets');
  return [...retained];
}
