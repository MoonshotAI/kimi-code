import { describe, expect, it } from 'vitest';

import { BugIndicatingError } from '#/_base/errors/errors';
import { createAppScope, setScopeTopology } from '#/_base/di/scope';

describe('Scope topology (kernel)', () => {
  it('skips the createChild order check while no topology is declared', () => {
    const app = createAppScope();
    const child = app.createChild('zzz', 'c1');
    const grandchild = child.createChild('app', 'g1');
    expect(child.kind).toBe('zzz');
    expect(grandchild.kind).toBe('app');
    app.dispose();
  });

  it('enforces the declared order once setScopeTopology runs', () => {
    setScopeTopology(['app', 'mid', 'leaf']);
    const app = createAppScope();
    const mid = app.createChild('mid', 'm1');
    expect(() => mid.createChild('leaf', 'l1')).not.toThrow();
    expect(() => mid.createChild('mid', 'm2')).toThrow(/greater/);
    expect(() => mid.createChild('app', 'a2')).toThrow(/greater/);
    expect(() => app.createChild('unknown', 'u1')).toThrow(/greater/);
    app.dispose();
  });

  it('treats an equal redeclaration as a no-op and rejects a different one', () => {
    expect(() => setScopeTopology(['app', 'mid', 'leaf'])).not.toThrow();
    expect(() => setScopeTopology(['app', 'leaf'])).toThrow(BugIndicatingError);
  });
});
