import { describe, expect, it } from 'vitest';

import { ContributionRegistry } from '#/_base/contribution/registry';

interface TestContribution {
  readonly items: readonly string[];
}

describe('ContributionRegistry', () => {
  it('stores one entry per sourceId and replaces on re-register', () => {
    const registry = new ContributionRegistry<TestContribution>();
    registry.register('a', { items: ['1'] }, { priority: 10 });
    registry.register('a', { items: ['2'] }, { priority: 20 });

    const entries = registry.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ sourceId: 'a', priority: 20, contribution: { items: ['2'] } });
    registry.dispose();
  });

  it('defaults priority to 0 and exposes entries with metadata', () => {
    const registry = new ContributionRegistry<TestContribution>();
    registry.register('a', { items: ['1'] });
    registry.register('b', { items: ['2'] }, { priority: 5 });

    expect(registry.get('a')?.priority).toBe(0);
    expect(registry.get('b')?.priority).toBe(5);
    expect(registry.entries().map((e) => e.sourceId)).toEqual(['a', 'b']);
    registry.dispose();
  });

  it('unregister removes the entry and is idempotent', () => {
    const registry = new ContributionRegistry<TestContribution>();
    registry.register('a', { items: ['1'] });
    registry.unregister('a');
    registry.unregister('a');

    expect(registry.entries()).toHaveLength(0);
    expect(registry.get('a')).toBeUndefined();
    registry.dispose();
  });

  it('handle dispose unregisters only the entry it registered', () => {
    const registry = new ContributionRegistry<TestContribution>();
    const stale = registry.register('a', { items: ['old'] });
    registry.register('a', { items: ['new'] });

    stale.dispose();

    expect(registry.get('a')?.contribution.items).toEqual(['new']);
    registry.dispose();
  });

  it('handle dispose is idempotent', () => {
    const registry = new ContributionRegistry<TestContribution>();
    const handle = registry.register('a', { items: ['1'] });
    handle.dispose();
    handle.dispose();

    expect(registry.entries()).toHaveLength(0);
    registry.dispose();
  });

  it('fires onDidChange with the sourceId on register, re-register, and unregister', () => {
    const registry = new ContributionRegistry<TestContribution>();
    const seen: string[] = [];
    registry.onDidChange((sourceId) => seen.push(sourceId));

    registry.register('a', { items: ['1'] });
    registry.register('a', { items: ['2'] });
    registry.unregister('a');
    registry.unregister('missing');

    expect(seen).toEqual(['a', 'a', 'a']);
    registry.dispose();
  });
});
