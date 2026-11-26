// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { modelsStore } from '../src/stores/models';

beforeEach(() => {
  localStorage.clear();
  modelsStore().$patch({ recentModelIds: [] });
});

describe('models store recent models', () => {
  it('records a target before its previous model, moves repeated uses to the front, and persists the result', () => {
    const store = modelsStore();

    store.noteRecentModel('provider/b', 'provider/a');
    store.noteRecentModel('provider/c', 'provider/b');
    store.noteRecentModel('provider/a');

    expect(store.recentModelIds).toEqual(['provider/a', 'provider/c', 'provider/b']);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.recentModels) ?? 'null')).toEqual([
      'provider/a',
      'provider/c',
      'provider/b',
    ]);
  });

  it('keeps the twenty most recent ids in storage', () => {
    const store = modelsStore();
    store.$patch({
      recentModelIds: Array.from({ length: 20 }, (_, index) => `provider/model-${index}`),
    });

    store.noteRecentModel('provider/new');

    expect(store.recentModelIds).toHaveLength(20);
    expect(store.recentModelIds[0]).toBe('provider/new');
    expect(store.recentModelIds.at(-1)).toBe('provider/model-18');
  });
});
