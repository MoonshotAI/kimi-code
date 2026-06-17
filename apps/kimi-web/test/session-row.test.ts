// apps/kimi-web/test/session-row.test.ts
//
// The sidebar row spins ONLY while the session is busy (running with a real
// task), and surfaces the 5-state lifecycle status: awaiting shows its pending
// tag, aborted shows a distinct "stopped" tag — neither spins.

import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { describe, expect, it } from 'vitest';

import SessionRow from '../src/components/SessionRow.vue';
import enWorkspace from '../src/i18n/locales/en/workspace';
import enSidebar from '../src/i18n/locales/en/sidebar';
import type { Session } from '../src/types';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { workspace: enWorkspace, sidebar: enSidebar } },
  missingWarn: false,
  fallbackWarn: false,
});

function row(session: Partial<Session>, extra: Record<string, unknown> = {}) {
  const full: Session = { id: 's1', title: 'Demo', time: '1m', status: 'idle', busy: false, ...session };
  return mount(SessionRow, {
    props: { session: full, active: false, ...extra },
    global: { plugins: [i18n] },
  });
}

describe('SessionRow status / busy', () => {
  it('spins only when busy', () => {
    expect(row({ status: 'running', busy: true }).find('.run-ico').exists()).toBe(true);
    // Awaiting input is not "working" — no spinner even though status != idle.
    expect(row({ status: 'awaitingApproval', busy: false }).find('.run-ico').exists()).toBe(false);
    expect(row({ status: 'aborted', busy: false }).find('.run-ico').exists()).toBe(false);
    expect(row({ status: 'idle', busy: false }).find('.run-ico').exists()).toBe(false);
  });

  it('shows the awaiting tag from status even without loaded pending counts', () => {
    const w = row({ status: 'awaitingApproval', busy: false });
    expect(w.find('.tag-approve').exists()).toBe(true);
    expect(w.find('.tag-aborted').exists()).toBe(false);
  });

  it('shows a distinct aborted tag', () => {
    const w = row({ status: 'aborted', busy: false });
    expect(w.find('.tag-aborted').exists()).toBe(true);
    expect(w.text()).toContain('Stopped');
  });

  it('shows no status tag for a plain idle session', () => {
    const w = row({ status: 'idle', busy: false });
    expect(w.find('.tag-approve').exists()).toBe(false);
    expect(w.find('.tag-ask').exists()).toBe(false);
    expect(w.find('.tag-aborted').exists()).toBe(false);
  });
});
