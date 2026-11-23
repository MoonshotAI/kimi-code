import { effectScope } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { registerExternalMenuSurface, registerMenuSurface } from '../../../../packages/app-ui/src/composables/menuStack';

vi.mock('@moonshot-ai/app-ui', async () => import('../../../../packages/app-ui/src/composables/menuStack'));

import { useMenuDragRegions } from '../../src/renderer/composables/useMenuDragRegions';

afterEach(() => vi.unstubAllGlobals());

it('suppresses window dragging synchronously for both native and DOM menus until the last menu closes', () => {
  const attributes = new Set<string>();
  vi.stubGlobal('document', { documentElement: {
    toggleAttribute: (name: string, open: boolean) => open ? attributes.add(name) : attributes.delete(name),
    removeAttribute: (name: string) => attributes.delete(name),
  } });
  const scope = effectScope();
  scope.run(useMenuDragRegions);
  expect(attributes.has('data-menu-open')).toBe(false);
  const closeNative = registerExternalMenuSurface();
  expect(attributes.has('data-menu-open')).toBe(true);
  const closeDom = registerMenuSurface({ contains: () => false });
  closeNative();
  expect(attributes.has('data-menu-open')).toBe(true);
  closeDom();
  expect(attributes.has('data-menu-open')).toBe(false);
  const closeRemaining = registerExternalMenuSurface();
  scope.stop();
  expect(attributes.has('data-menu-open')).toBe(false);
  closeRemaining();
});
