import { describe, expect, it } from 'vitest';

import { IInstantiationService } from '#/di/instantiation';
import { InstantiationService } from '#/di/instantiationService';
import { ServiceCollection } from '#/di/serviceCollection';

/**
 * P0.5 — the container self-registers under `IInstantiationService`. Any
 * `accessor.get(IInstantiationService)` returns the OWNING container —
 * root for invocations made on the root, child for invocations made on a
 * child — enabling factory and per-request-scope patterns without callers
 * having to thread the container through manually.
 */
describe('IInstantiationService self-registration (P0.5)', () => {
  it('uses the VS Code diagnostic service id', () => {
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
