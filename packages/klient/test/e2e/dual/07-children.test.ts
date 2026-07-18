/**
 * Dual-backend rewrite of scenario `07-session-children`: child/grandchild
 * creation markers and direct-children listing semantics, via the session
 * facade's `createChild` and the session index's `childOf` query.
 */
import { expect, it } from 'vitest';

import { defineDualSuite } from '../../helpers/dual.js';

defineDualSuite('session children', {}, ({ klient }) => {
  it('child markers, listing semantics, and missing-parent handling', async () => {
    const k = klient();
    const parent = await k.global.sessions.create({
      workDir: process.cwd(),
      title: 'dual-parent',
    });

    const child = await k.session(parent.id).createChild({ title: 'dual-child' });
    expect(child.custom?.['parent_session_id']).toBe(parent.id);
    expect(child.custom?.['child_session_kind']).toBe('child');

    const grandchild = await k.session(child.id).createChild({ title: 'dual-grandchild' });

    const parentChildren = await k.global.sessions.list({ childOf: parent.id });
    expect(parentChildren.items.some((s) => s.id === child.id)).toBe(true);
    expect(parentChildren.items.some((s) => s.id === grandchild.id)).toBe(false);

    const childChildren = await k.global.sessions.list({ childOf: child.id });
    expect(childChildren.items.some((s) => s.id === grandchild.id)).toBe(true);

    const missing = await k.global.sessions.list({ childOf: 'sess_missing_dual_children' });
    expect(missing.items).toEqual([]);

    await k.session(grandchild.id).archive();
    await k.session(child.id).archive();
    await k.session(parent.id).archive();
  }, 30_000);
});
