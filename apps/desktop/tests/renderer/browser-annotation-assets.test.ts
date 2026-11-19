import { describe, expect, it } from 'vitest';
import { collectStoredBrowserAssetIds } from '../../src/renderer/lib/browserAnnotationAssets';

function storage(values: string[]): Storage {
  return { length: values.length, key: (i: number) => String(i), getItem: (key: string) => values[Number(key)] ?? null } as Storage;
}

describe('stored browser asset roots', () => {
  it('retains references from inactive drafts and nested history snapshots', () => {
    const roots = collectStoredBrowserAssetIds(storage([
      JSON.stringify({ attachments: [{ browserAssetId: 'draft-shot' }] }),
      JSON.stringify([{ snapshot: { attachments: [{ browserAssetId: 'history-shot' }, { browserAssetId: 'draft-shot' }] } }]),
      'unrelated setting',
    ]));
    expect(new Set(roots)).toEqual(new Set(['draft-shot', 'history-shot']));
  });
  it('aborts cleanup when reference storage cannot be decoded', () => {
    expect(() => collectStoredBrowserAssetIds(storage(['{"browserAssetId":']))).toThrow();
  });
});
