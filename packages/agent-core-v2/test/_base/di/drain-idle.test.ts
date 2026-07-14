import { describe, expect, it } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { SyncDescriptor } from '#/_base/di/descriptors';

interface ILeaf {
  readonly tag: 'leaf';
}

const ILeaf = createDecorator<ILeaf>('drain-leaf');
const IMid = createDecorator<{ readonly leaf: ILeaf }>('drain-mid');

describe('InstantiationService.drainIdle', () => {
  it('constructs delayed services synchronously, including chains created while draining', () => {
    const order: string[] = [];
    class Leaf implements ILeaf {
      readonly tag = 'leaf' as const;
      constructor() {
        order.push('leaf');
      }
    }
    class Mid {
      readonly leaf: ILeaf;
      constructor(@ILeaf leaf: ILeaf) {
        this.leaf = leaf;
        order.push('mid');
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection(
        [ILeaf, new SyncDescriptor(Leaf, [], true)],
        [IMid, new SyncDescriptor(Mid, [], true)],
      ),
    );

    const mid = ix.invokeFunction((a) => a.get(IMid));
    // The delayed proxy is in hand but nothing has constructed yet.
    expect(order).toEqual([]);

    ix.drainIdle();
    // Both constructed in dependency order (leaf before its consumer mid):
    // mid's leaf dependency joined the drain and was forced in the same pass.
    expect(order).toEqual(['leaf', 'mid']);
    expect(mid.leaf.tag).toBe('leaf');
  });
});
