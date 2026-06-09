// apps/kimi-web/src/composables/__tests__/useIsMobile.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { useIsMobile } from '../useIsMobile';

// Mount the composable inside a real component so onUnmounted / lifecycle hooks
// have an active instance. Expose a getter so the test reads the live ref value
// (Vue's `expose` shallow-unwraps a ref, dropping `.value`).
function mountWithMobile() {
  const Host = defineComponent({
    setup(_, { expose }) {
      const isMobile = useIsMobile();
      expose({ get value() { return isMobile.value; } });
      return () => h('div');
    },
  });
  return mount(Host) as ReturnType<typeof mount> & { vm: { value: boolean } };
}

describe('useIsMobile', () => {
  afterEach(() => {
    // Reset any matchMedia stub between tests.
    // @ts-expect-error - allow deleting the test stub
    delete window.matchMedia;
    vi.restoreAllMocks();
  });

  it('jsdom 无 matchMedia 时默认返回 false（桌面）', () => {
    // jsdom does not implement matchMedia; the composable must not throw and
    // must default to desktop (false) so existing component tests stay desktop.
    expect(window.matchMedia).toBeUndefined();
    const w = mountWithMobile();
    expect(w.vm.value).toBe(false);
  });

  it('matchMedia.matches=true 时返回 true（窄视口）', () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;

    const w = mountWithMobile();
    expect(w.vm.value).toBe(true);
  });

  it('media query 变化时响应式更新', async () => {
    let changeHandler: ((e: { matches: boolean }) => void) | null = null;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        changeHandler = cb;
      },
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;

    const w = mountWithMobile();
    expect(w.vm.value).toBe(false);

    // Simulate the viewport crossing the breakpoint.
    expect(changeHandler).not.toBeNull();
    changeHandler!({ matches: true });
    await nextTick();
    expect(w.vm.value).toBe(true);
  });
});
