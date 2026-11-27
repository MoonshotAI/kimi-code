// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { createKimiI18n } from '@moonshot-ai/app-i18n';

vi.mock('@moonshot-ai/app-components', () => ({
  BottomSheet: {
    render(this: { $slots: { default?: () => ReturnType<typeof h>[] } }) {
      return h('div', this.$slots.default?.());
    },
  },
  RcDeviceSwitcher: { render: () => null },
}));

import MobileSwitcherSheet from '../../src/renderer/components/mobile/MobileSwitcherSheet.vue';

let app: App | null = null;
let host: HTMLDivElement;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Session',
    time: '1m',
    busy: false,
    pendingInteraction: 'none',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function mountRows(rows: Session[]): void {
  app = createApp({
    render: () => h(MobileSwitcherSheet, {
      modelValue: true,
      groups: [],
      flatSessions: rows,
      pinnedSessions: [],
      activeWorkspaceId: null,
      activeId: '',
    }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  window.localStorage.clear();
});

describe('desktop mobile switcher workspace label', () => {
  it('prefers the workspace name and updates after rename', async () => {
    const rows = reactive([session({ workspaceName: 'Before', cwdLabel: 'code-app-2' })]);
    mountRows(rows);
    expect(host.querySelector('.srow-sub')?.textContent).toBe('Before');

    rows[0]!.workspaceName = 'After';
    await nextTick();
    expect(host.querySelector('.srow-sub')?.textContent).toBe('After');
    expect(host.textContent).not.toContain('code-app-2');
  });

  it('falls back to the cwd label and empty placeholder', () => {
    mountRows([
      session({ id: 'fallback', cwdLabel: 'code-app-2', updatedAt: '2026-01-02T00:00:00.000Z' }),
      session({ id: 'empty', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);

    const labels = [...host.querySelectorAll('.srow-sub')].map((el) => el.textContent);
    expect(labels).toEqual(['code-app-2', '-']);
  });
});
