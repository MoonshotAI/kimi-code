// @vitest-environment jsdom
import { createApp, computed, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/app-markdown', async () => {
  const vue = await import('vue');
  return {
    Markdown: vue.defineComponent({
      name: 'Markdown',
      props: { text: { type: String, default: '' } },
      setup: (props) => () => vue.h('div', { class: 'md-stub' }, props.text),
    }),
  };
});

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { NotifyUserEnabledKey } from '@moonshot-ai/app-client/contracts';
import type { ToolCall as ToolCallData } from '@moonshot-ai/app-core/client/types';
import ToolCall from '../src/chat/ToolCall.vue';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

function mount(render: () => ReturnType<typeof h>, provide?: (app: App) => void): HTMLDivElement {
  app = createApp({ render });
  app.use(createKimiI18n({ locale: 'en' }));
  provide?.(app);
  app.mount(host);
  return host;
}

function notifyTool(over: Partial<ToolCallData> = {}, args: object = {}): ToolCallData {
  return {
    id: 'call_notify',
    name: 'NotifyUser',
    arg: JSON.stringify({ title: 'Root cause found', message: 'Two refreshes reuse one token.', ...args }),
    status: 'ok',
    startedAt: new Date().toISOString(),
    ...over,
  };
}

describe('NotifyUser progress row', () => {
  it('shows the title and time, and opens the message on click', async () => {
    const el = mount(() => h(ToolCall, { tool: notifyTool() }));
    await nextTick();
    expect(el.querySelector('.pg-title')?.textContent).toBe('Root cause found');
    expect(el.querySelector('.pg-time')?.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(el.querySelector('.kw-dot--unread')).not.toBeNull();
    expect(el.querySelector('.tool-line')?.classList.contains('open')).toBe(false);
    expect(el.querySelector('.md-stub')?.textContent).toBe('Two refreshes reuse one token.');

    (el.querySelector('.tl-head') as HTMLElement).click();
    await nextTick();
    expect(el.querySelector('.tool-line')?.classList.contains('open')).toBe(true);
  });

  it('derives a title from an update posted without one', async () => {
    const el = mount(() =>
      h(ToolCall, {
        tool: notifyTool({ arg: JSON.stringify({ message: 'Parser reviewed.\n\nNo issues.' }) }),
      }),
    );
    await nextTick();
    expect(el.querySelector('.pg-title')?.textContent).toBe('Parser reviewed.');
    expect(el.querySelector('.md-stub')?.textContent).toBe('No issues.');
  });

  it('keeps the full text available for a single-line update without a title', async () => {
    const text = 'A single-line progress update that remains readable after expansion.';
    const el = mount(() =>
      h(ToolCall, {
        tool: notifyTool({ arg: JSON.stringify({ message: text }) }),
      }),
    );
    await nextTick();
    expect(el.querySelector('.pg-title')?.textContent).toBe(text);
    expect(el.querySelector('.tool-line')?.classList.contains('expandable')).toBe(true);
    expect(el.querySelector('.md-stub')?.textContent).toBe(text);
  });

  it('shows a placeholder while the arguments are still streaming', async () => {
    const el = mount(() =>
      h(ToolCall, { tool: notifyTool({ status: 'running', arg: '{"title": "Root ca', startedAt: undefined }) }),
    );
    await nextTick();
    expect(el.querySelector('.pg-title')?.textContent).toBe('Posting an update…');
    expect(el.querySelector('.pg-time')).toBeNull();
  });

  it('falls back to the generic tool row when the call failed', async () => {
    const el = mount(() => h(ToolCall, { tool: notifyTool({ status: 'error', output: ['title must not be empty.'] }) }));
    await nextTick();
    expect(el.querySelector('.pg-title')).toBeNull();
    expect(el.textContent).toContain('tools.label.notify_user');
  });

  it('falls back to the generic tool row when NotifyUser is disabled', async () => {
    const el = mount(
      () => h(ToolCall, { tool: notifyTool() }),
      (app) => {
        app.provide(NotifyUserEnabledKey, computed(() => false));
      },
    );
    await nextTick();
    expect(el.querySelector('.pg-title')).toBeNull();
    expect(el.querySelector('.kw-dot--unread')).toBeNull();
    expect(el.textContent).toContain('tools.label.notify_user');
  });
});
