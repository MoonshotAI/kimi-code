import { describe, expect, it } from 'vitest';

import { IInstantiationService } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';

describe('IInstantiationService self-registration', () => {
  it('uses the conventional service id string', () => {
    expect(String(IInstantiationService)).toBe('instantiationService');
  });

  it('root container exposes itself via accessor.get(IInstantiationService)', () => {
    const ix = new InstantiationService();
    const resolved = ix.invokeFunction((a) => a.get(IInstantiationService));
    expect(resolved).toBe(ix);
  });

  it('child container resolves to ITSELF, not the parent', () => {
    const parent = new InstantiationService();
    const child = parent.createChild(new ServiceCollection());
    const resolvedChild = child.invokeFunction((a) => a.get(IInstantiationService));
    const resolvedParent = parent.invokeFunction((a) => a.get(IInstantiationService));
    expect(resolvedChild).toBe(child);
    expect(resolvedParent).toBe(parent);
    expect(resolvedChild).not.toBe(resolvedParent);
  });

  it('multiple roots resolve to distinct instances', () => {
    const a = new InstantiationService();
    const b = new InstantiationService();
    expect(a.invokeFunction((acc) => acc.get(IInstantiationService))).toBe(a);
    expect(b.invokeFunction((acc) => acc.get(IInstantiationService))).toBe(b);
  });
});
