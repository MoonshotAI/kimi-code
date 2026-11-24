// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { ChatTurn, ToolCall } from '@moonshot-ai/app-core/client/types';
import BrowserSources from '../src/chat/tool-calls/browser/BrowserSources.vue';
import { browserHandledDialogs } from '../src/chat/tool-calls/browserActivity';

const PATH = '/Users/me/Downloads/BaiduNetdisk_mac_8.8.8_arm64.dmg';
let serial = 0;

function call(operation: string, result: Record<string, unknown>): ToolCall {
  serial++;
  return {
    id: `call-${serial}`,
    name: 'mcp__desktop_browser__run',
    arg: JSON.stringify({ protocol: 'kimi.browser/1.0.0', operation, tabId: 'tab-1' }),
    status: 'ok',
    output: [JSON.stringify({ ok: true, operation, ...result })],
  };
}

const confirm = { id: 'record-1', kind: 'confirm', origin: 'https://shop.example', message: 'Place order?', outcome: 'accepted', answerer: 'agent', openedAt: 1, settledAt: 2 };
const download = { id: 'record-2', kind: 'download', origin: 'https://pan.example', message: 'BaiduNetdisk_mac_8.8.8_arm64.dmg', outcome: 'saved', answerer: 'auto', openedAt: 3, settledAt: 4, files: [PATH], downloadId: 'download-1' };

describe('browser handled dialogs', () => {
  it('collects handled dialogs from browser results, newest update wins and invalid ones are dropped', () => {
    const tools = [
      call('page.dialog.respond', { handledDialogs: [confirm] }),
      call('page.element.click', { handledDialogs: [download, { id: 'x', kind: 'bogus', outcome: 'saved', answerer: 'auto' }] }),
      call('browser.get_state', { handledDialogs: [{ ...download, outcome: 'too-large', files: undefined, settledAt: 5 }] }),
    ];
    expect(browserHandledDialogs(tools)).toEqual([
      { id: 'record-1', kind: 'confirm', origin: 'https://shop.example', message: 'Place order?', outcome: 'accepted', answerer: 'agent', settledAt: 2, files: [] },
      { id: 'record-2', kind: 'download', origin: 'https://pan.example', message: 'BaiduNetdisk_mac_8.8.8_arm64.dmg', outcome: 'too-large', answerer: 'auto', settledAt: 5, files: [] },
    ]);
  });

  it('keeps handled text prompt records', () => {
    const prompt = { id: 'record-3', kind: 'prompt', origin: 'https://shop.example', message: 'Coupon code?', outcome: 'accepted', answerer: 'user', openedAt: 1, settledAt: 2 };
    expect(browserHandledDialogs([call('page.dialog.respond', { handledDialogs: [prompt] })]).map(dialog => dialog.kind)).toEqual(['prompt']);
  });

  it('keeps the shared answer of a text prompt and shows it in the dialogs group', async () => {
    const prompt = { id: 'record-4', kind: 'prompt', origin: 'https://shop.example', message: 'Coupon code?', text: '<b>SAVE10</b>', outcome: 'accepted', answerer: 'agent', openedAt: 1, settledAt: 2 };
    const tools = [call('page.dialog.respond', { handledDialogs: [prompt] })];
    expect(browserHandledDialogs(tools)).toEqual([expect.objectContaining({ id: 'record-4', text: '<b>SAVE10</b>' })]);
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp({ render: () => h(BrowserSources, { turns: [{ id: 'turn', sessionId: 'session', role: 'assistant', no: 1, text: '', tools }] }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    try {
      host.querySelector<HTMLButtonElement>('.bsrc-pill')!.click();
      await nextTick();
      const row = host.querySelector('.bsrc-dialog')!;
      expect(row.textContent).toContain('Answered: "<b>SAVE10</b>"');
      expect(row.querySelector('b')).toBeNull();
    } finally { app.unmount(); host.remove(); }
  });
});

describe('BrowserSources dialogs group', () => {
  let app: App | null = null;
  afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = ''; });

  async function mount(tools: ToolCall[]): Promise<HTMLElement> {
    const turns: ChatTurn[] = [{ id: 'turn', sessionId: 'session', role: 'assistant', no: 1, text: '', tools }];
    const host = document.createElement('div');
    document.body.append(host);
    app = createApp({ render: () => h(BrowserSources, { turns }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();
    return host;
  }

  it('lists handled dialogs with kind, origin, outcome, answerer and wrapped paths', async () => {
    const host = await mount([
      call('tab.navigate', { tab: { tabId: 'tab-1', url: 'https://shop.example/cart', title: 'Cart' } }),
      call('page.dialog.respond', { handledDialogs: [confirm, download] }),
    ]);
    const pill = host.querySelector<HTMLButtonElement>('.bsrc-pill')!;
    expect(pill.textContent).toContain('2 page dialogs');
    pill.click();
    await nextTick();
    const group = host.querySelector('.bsrc-dialogs')!;
    expect(group.querySelector('.bsrc-group-title')?.textContent).toBe('Page dialogs');
    const rows = [...group.querySelectorAll('.bsrc-dialog')];
    expect(rows.map(row => row.querySelector('.bsrc-title')?.textContent)).toEqual(['Confirmation', 'Download']);
    expect(rows[0]!.textContent).toContain('https://shop.example · Accepted by the agent');
    expect(rows[1]!.textContent).toContain('Saved automatically');
    expect(rows[1]!.querySelector('.bsrc-path')?.textContent).toBe(PATH);
  });

  it('shows the sources pill for dialogs even when no page was visited', async () => {
    const host = await mount([call('browser.get_state', { handledDialogs: [{ ...confirm, kind: 'print', outcome: 'blocked', answerer: 'auto' }] })]);
    expect(host.querySelector('.bsrc-pill')?.textContent).toContain('1 page dialog');
  });
});
