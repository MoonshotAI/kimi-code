// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
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
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import AskUserTool from '../src/chat/tool-calls/AskUserTool.vue';
import { parseAskBackground } from '../src/chat/tool-calls/askUserToolParse';

const QUESTION = 'core 修复需要基于最新 origin/main，你希望在哪里实施？';
const LAUNCH_OUTPUT = [
  'task_id: question-2fi9py5i\nstatus: running\nnext_step: Continue your work; the answer arrives automatically in a later message. Use TaskStop only to cancel the question.',
];

let app: App | null = null;
let host: HTMLDivElement;

function askTool(over: Partial<ToolCall> = {}, args: object = {}): ToolCall {
  return {
    id: 'call_question',
    name: 'AskUserQuestion',
    arg: JSON.stringify({
      questions: [
        {
          question: QUESTION,
          options: [
            { label: '当前 worktree', description: '' },
            { label: '新建 worktree', description: '' },
          ],
        },
      ],
      ...args,
    }),
    status: 'ok',
    startedAt: new Date().toISOString(),
    ...over,
  };
}

function mount(tool: Parameters<typeof ref<ToolCall>>[0]) {
  const current = ref(tool);
  app = createApp({
    setup: () => () => h(AskUserTool, { tool: current.value }),
  });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.provide(IconResolverKey, name => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  return current;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

describe('background AskUserQuestion row', () => {
  it('reads the background flag without tolerating malformed input', () => {
    expect(parseAskBackground(JSON.stringify({ background: true }))).toBe(true);
    expect(parseAskBackground(JSON.stringify({ background: false }))).toBe(false);
    expect(parseAskBackground('{"background":')).toBe(false);
    expect(parseAskBackground('')).toBe(false);
  });

  it('stays collapsed and never exposes launch internals', async () => {
    mount(askTool({ output: LAUNCH_OUTPUT }, { background: true }));
    await nextTick();

    expect(host.querySelector('.tool-line')?.classList.contains('open')).toBe(false);
    expect(host.querySelector('.tl-name')?.textContent).toBe('后台提问');
    expect(host.querySelector('.tl-dim')?.textContent).toBe(QUESTION);
    expect(host.querySelector('.tl-faint')?.textContent).toBe('等待回答');
    expect(host.textContent).not.toContain('task_id');
    expect(host.textContent).not.toContain('status: running');
    expect(host.textContent).not.toContain('next_step');

    (host.querySelector('.tl-head') as HTMLElement).click();
    await nextTick();
    expect(host.querySelector('.tool-line')?.classList.contains('open')).toBe(true);
    expect(host.querySelector('.rc-qtext')?.textContent).toBe(QUESTION);
    expect(host.textContent).not.toContain('task_id');
    expect(host.textContent).not.toContain('status: running');
    expect(host.textContent).not.toContain('next_step');
    expect(host.querySelector('.ask-raw')).toBeNull();
  });

  it('does not auto-open when streaming arguments and launch output arrive', async () => {
    const current = mount(askTool({ status: 'running' }, { background: true, questions: [] }));
    await nextTick();
    expect(host.querySelector('.tool-line')?.classList.contains('open')).toBe(false);

    current.value = askTool({ status: 'ok', output: LAUNCH_OUTPUT }, { background: true });
    await nextTick();
    expect(host.querySelector('.tool-line')?.classList.contains('open')).toBe(false);
    expect(host.querySelector('.tl-dim')?.textContent).toBe(QUESTION);
  });

  it('keeps the foreground behavior of opening when the answer arrives', async () => {
    const current = mount(askTool({ status: 'running' }));
    await nextTick();
    expect(host.querySelector('.tool-line')?.classList.contains('open')).toBe(false);

    current.value = askTool({
      status: 'ok',
      output: [JSON.stringify({ answers: { [QUESTION]: '当前 worktree' } })],
    });
    await nextTick();
    expect(host.querySelector('.tool-line')?.classList.contains('open')).toBe(true);
    expect(host.querySelector('.tl-name')?.textContent).toBe('用户回答收集');
    expect(host.querySelector('.rc-answer')?.textContent).toBe('当前 worktree');
  });
});
