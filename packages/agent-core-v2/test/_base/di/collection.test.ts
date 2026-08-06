import { describe, expect, it } from 'vitest';

import {
  collection,
  type CollectionChange,
  type CollectionView,
} from '#/_base/di/collection';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { Service } from '#/_base/di/service';
import { ServiceCollection } from '#/_base/di/serviceCollection';

interface Tool {
  readonly name: string;
}

const ToolContribution = collection<Tool>('test-tool-contribution');

interface IContributor {
  marker: string;
}
const IContributor = createDecorator<IContributor>('collection-contributor');

interface IFold {
  marker: string;
}
const IFold = createDecorator<IFold>('collection-fold');

class Contributor extends Service {
  constructor(value: Tool) {
    super();
    this.provide(ToolContribution, value);
  }
}

class Fold extends Service {
  disposed = false;
  constructor(@ToolContribution readonly view: CollectionView<Tool>) {
    super();
  }
  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }
}

function contributeIn(container: InstantiationService, value: Tool): void {
  container.provide(IContributor, new SyncDescriptor(Contributor, [value] as never));
  container.invokeFunction((a) => a.get(IContributor));
}

function foldIn(container: InstantiationService): Fold {
  container.provide(IFold, new SyncDescriptor(Fold));
  return container.invokeFunction((a) => a.get(IFold)) as unknown as Fold;
}

describe('collection tokens — visibility & record lifetime (D12)', () => {
  it('flows records upward: a child-scope record lands on the root fold view', () => {
    const root = new InstantiationService(new ServiceCollection(), true);
    const child = root.createChild(new ServiceCollection()) as InstantiationService;
    const fold = foldIn(root);
    expect(fold.view.items).toEqual([]);
    contributeIn(child, { name: 'from-child' });
    expect(fold.view.items).toEqual([{ name: 'from-child' }]);
    expect(fold.view.records[0]!.providerName).toBe('Contributor');
    expect(fold.view.records[0]!.scopePath).toContain('#');
    root.dispose();
  });

  it('flows records downward: a root record is visible to a child view', () => {
    const root = new InstantiationService(new ServiceCollection(), true);
    contributeIn(root, { name: 'from-root' });
    const child = root.createChild(new ServiceCollection()) as InstantiationService;
    const fold = foldIn(child);
    expect(fold.view.items).toEqual([{ name: 'from-root' }]);
    root.dispose();
  });

  it('never leaks records into sibling subtrees', () => {
    const root = new InstantiationService(new ServiceCollection(), true);
    const childA = root.createChild(new ServiceCollection()) as InstantiationService;
    const childB = root.createChild(new ServiceCollection()) as InstantiationService;
    contributeIn(childA, { name: 'A' });
    const foldB = foldIn(childB);
    expect(foldB.view.items).toEqual([]);
    root.dispose();
  });

  it('withdraws records when the provider dies, with incremental payloads', () => {
    const root = new InstantiationService(new ServiceCollection(), true);
    const child = root.createChild(new ServiceCollection()) as InstantiationService;
    const changes: CollectionChange<Tool>[] = [];
    const fold = foldIn(root);
    const subscription = fold.view.onDidChange((change) => changes.push(change));
    contributeIn(child, { name: 'ephemeral' });
    expect(changes).toEqual([{ added: [{ name: 'ephemeral' }], removed: [] }]);
    child.dispose();
    expect(changes).toEqual([
      { added: [{ name: 'ephemeral' }], removed: [] },
      { added: [], removed: [{ name: 'ephemeral' }] },
    ]);
    subscription.dispose();
    root.dispose();
  });

  it('withdraws records when the providing unit is unprovided', () => {
    const root = new InstantiationService(new ServiceCollection(), true);
    const fold = foldIn(root);
    contributeIn(root, { name: 'owned' });
    expect(fold.view.items).toEqual([{ name: 'owned' }]);
    root.unprovide(IContributor);
    expect(fold.view.items).toEqual([]);
    root.dispose();
  });

  it('replays surviving records into a rebuilt fold (records outlive folds)', () => {
    const root = new InstantiationService(new ServiceCollection(), true);
    contributeIn(root, { name: 'durable' });
    const first = foldIn(root);
    expect(first.view.items).toEqual([{ name: 'durable' }]);
    root.unprovide(IFold);
    const second = foldIn(root);
    expect(second.view.items).toEqual([{ name: 'durable' }]);
    root.dispose();
  });

  it('records a collection edge in the graph and never cascades the fold on changes', () => {
    const root = new InstantiationService(new ServiceCollection(), true);
    const fold = foldIn(root);
    const edges = root.dependencyGraph.edges();
    expect(
      edges.some(
        (edge) =>
          edge.kind === 'collection' &&
          String(edge.dependency.token) === 'collection:test-tool-contribution',
      ),
    ).toBe(true);
    const child = root.createChild(new ServiceCollection()) as InstantiationService;
    contributeIn(child, { name: 'x' });
    child.dispose();
    expect(fold.disposed).toBe(false);
    root.dispose();
  });
});
