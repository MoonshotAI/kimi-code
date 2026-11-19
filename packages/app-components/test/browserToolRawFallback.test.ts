// @vitest-environment jsdom
import { createApp, h, nextTick, shallowRef, type App } from 'vue';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import BrowserToolDetails from '../src/chat/tool-calls/browser/BrowserToolDetails.vue';
import { browserToolView } from '../src/chat/tool-calls/browserToolView';

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

const running: ToolCall = {
  id: 'tool-1',
  name: 'mcp__desktop_browser__run',
  arg: JSON.stringify({ protocol: 'kimi.browser/1.0.0', operation: 'tab.get_state', tabId: 'panel-tab-3' }),
  status: 'running',
};

function rawFold(): HTMLButtonElement {
  const fold = [...host.querySelectorAll<HTMLButtonElement>('button.bfold-head')].find((item) => item.textContent?.includes('原始数据'));
  if (fold === undefined) throw new Error('missing raw data fold');
  return fold;
}

it('opens the raw data when a result that arrives while the details are open cannot be parsed', async () => {
  const tool = shallowRef<ToolCall>(running);
  app = createApp({
    render: () => h(BrowserToolDetails, { tool: tool.value, view: browserToolView(tool.value, {}), running: tool.value.status === 'running' }),
  });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.mount(host);
  expect(rawFold().getAttribute('aria-expanded')).toBe('false');

  tool.value = { ...running, status: 'ok', output: ['Tool execution was interrupted'] };
  await nextTick();
  expect(rawFold().getAttribute('aria-expanded')).toBe('true');
  expect(host.textContent).toContain('Tool execution was interrupted');

  rawFold().click();
  await nextTick();
  expect(rawFold().getAttribute('aria-expanded')).toBe('false');
});
