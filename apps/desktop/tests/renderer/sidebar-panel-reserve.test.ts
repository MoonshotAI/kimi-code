// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, ref } from 'vue';
import { usePanelTabs, useSidebarLayout } from '@moonshot-ai/app-client/composables';

const SIDEBAR = 300;
const TRANSCRIPT_MIN = 320;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('panel width bound', () => {
  it.each([
    ['open', false, SIDEBAR],
    ['collapsed', true, 0],
  ])('reserves only the rendered sidebar when it is %s', (_label, collapsed, reserved) => {
    const store = new Map([
      ['kimi-web.sidebar-width', String(SIDEBAR)],
      ['kimi-web.sidebar-collapsed', String(collapsed)],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    const client = {
      turns: ref([]),
      activeAppTasks: ref([]),
      activeSessionId: ref(null),
      activeWorkspaceId: ref(null),
    };
    let panel!: ReturnType<typeof usePanelTabs>;
    const app = createApp({
      setup() {
        const layout = useSidebarLayout();
        panel = usePanelTabs({ client: client as never, sideWidth: layout.sidebarOccupiedWidth, t: (key: string) => key });
        return () => null;
      },
    });
    app.mount(document.createElement('div'));

    expect(panel.previewMax.value).toBe(window.innerWidth - reserved - TRANSCRIPT_MIN);
    app.unmount();
  });
});
