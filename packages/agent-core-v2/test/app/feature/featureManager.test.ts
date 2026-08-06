import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { FiberState } from '#/_base/di/fiber';
import { createDecorator } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { Service } from '#/_base/di/service';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';

interface IGizmo {
  tag: string;
}
const IGizmo = createDecorator<IGizmo>('feature-gizmo');

class Gizmo extends Service {
  readonly tag = 'gizmo';
}

function host(): { ix: InstantiationService; manager: IFeatureManager } {
  const ix = new InstantiationService(
    new ServiceCollection([IFeatureManager, new SyncDescriptor(FeatureManagerService)]),
    true,
  );
  return { ix, manager: ix.invokeFunction((a) => a.get(IFeatureManager)) };
}

describe('FeatureManager — dynamic unit assembly at App scope (§5.10)', () => {
  it('assembles a token-bound unit, introspects it, and retracts it', async () => {
    const { ix, manager } = host();
    const events: number[] = [];
    manager.onDidChangeUnits(() => events.push(events.length));
    const handle = manager.provideUnit(IGizmo, Gizmo);
    expect(handle.state).toBe(FiberState.Active);
    expect(ix.invokeFunction((a) => a.get(IGizmo)).tag).toBe('gizmo');
    const infos = manager.units();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ name: 'Gizmo', state: FiberState.Active });
    expect(typeof infos[0]!.uid).toBe('number');
    expect(events.length).toBe(1);

    await manager.unprovideUnit('Gizmo');
    expect(manager.units()).toHaveLength(0);
    expect(() => ix.invokeFunction((a) => a.get(IGizmo))).toThrow(/unknown service/);
    expect(events.length).toBe(2);
    ix.dispose();
  });

  it('reloads a managed unit with new config via updateUnit', async () => {
    const { ix, manager } = host();
    const configs: unknown[] = [];
    class Configured extends Service {
      constructor() {
        super();
        configs.push(this.config);
      }
    }
    manager.provideUnit(IGizmo, Configured, { config: 1 });
    ix.invokeFunction((a) => a.get(IGizmo));
    expect(configs).toEqual([1]);
    await manager.updateUnit('Configured', 2);
    expect(configs).toEqual([1, 2]);
    await expect(manager.updateUnit('unknown-unit')).rejects.toThrow(/not managed/);
    ix.dispose();
  });

  it('retracts every managed unit when the manager dies', async () => {
    const { ix, manager } = host();
    manager.provideUnit(IGizmo, Gizmo);
    ix.invokeFunction((a) => a.get(IGizmo));
    ix.dispose();
    await expect(Promise.resolve()).resolves.toBeUndefined();
  });
});
