// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import { messages } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { ModelDisplayKey, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import type { TaskItem, ToolCall } from '@moonshot-ai/app-core/client/types';
import BackgroundTaskTool from '../src/chat/tool-calls/BackgroundTaskTool.vue';
import EditTool from '../src/chat/tool-calls/EditTool.vue';
import GenericTool from '../src/chat/tool-calls/GenericTool.vue';
import GlobTool from '../src/chat/tool-calls/GlobTool.vue';
import GoalTool from '../src/chat/tool-calls/GoalTool.vue';
import GrepTool from '../src/chat/tool-calls/GrepTool.vue';
import ReadTool from '../src/chat/tool-calls/ReadTool.vue';
import SkillTool from '../src/chat/tool-calls/SkillTool.vue';
import WaitForTool from '../src/chat/tool-calls/WaitForTool.vue';
import WebFetchTool from '../src/chat/tool-calls/WebFetchTool.vue';
import SubagentGrid from '../src/chat/dock/SubagentGrid.vue';
import TasksPane from '../src/chat/dock/TasksPane.vue';

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

let app: App | null = null;
let host: HTMLDivElement;
let history: Map<string, unknown>;
const openFile = vi.fn();
const openAgent = vi.fn();

function tool(id: string, name: string, arg: string, status: ToolCall['status'], extra: Partial<ToolCall> = {}): ToolCall {
  return { id, name, arg, status, startedAt: '2026-01-01T00:00:00.000Z', ...extra };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

function mountTool(component: Component, current: ToolCall, locale: 'en' | 'zh' = 'en') {
  const i18n = createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en',
    messages: JSON.parse(JSON.stringify(messages)),
    warnHtmlMessage: false,
  });
  setKimiClientDeps({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? i18n.global.t(key) : i18n.global.t(key, params),
  } as never);
  app = createApp({ setup: () => () => h(component, { tool: current }) });
  app.use(i18n);
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.provide(HistoryStateKey, history);
  app.provide(panelApiKey, { openFile, openAgent });
  app.mount(host);
  return i18n;
}

function head(): HTMLElement {
  return host.querySelector<HTMLElement>('.tl-head')!;
}

function isOpen(): boolean {
  return host.querySelector('.tool-line')?.classList.contains('open') === true;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
  history = new Map();
  openFile.mockReset();
  openAgent.mockReset();
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  resetKimiClientDeps();
  vi.unstubAllGlobals();
});

describe('tool card disclosure state', () => {
  it('starts collapsed by default, toggles on click and persists to history state', async () => {
    mountTool(GlobTool, tool('g1', 'Glob', '{"pattern":"*.ts"}', 'ok', { output: ['a.ts'] }));
    await settle();
    expect(isOpen()).toBe(false);

    head().click();
    await settle();
    expect(isOpen()).toBe(true);
    expect(history.get('tool:g1:open')).toBe(true);
    expect(host.querySelectorAll('.file-row')).toHaveLength(1);

    head().click();
    await settle();
    expect(isOpen()).toBe(false);
    expect(history.get('tool:g1:open')).toBe(false);
  });

  it('restores open state from history and opens initially when defaultExpanded is set', async () => {
    history.set('tool:g2:open', true);
    mountTool(GlobTool, tool('g2', 'Glob', '{"pattern":"*.ts"}', 'ok', { output: ['a.ts'] }));
    await settle();
    expect(isOpen()).toBe(true);

    app?.unmount();
    history.clear();
    mountTool(WebFetchTool, tool('f1', 'FetchURL', '{"url":"https://example.com/a"}', 'ok', { output: ['ok'], defaultExpanded: true }));
    await settle();
    expect(isOpen()).toBe(true);
  });

  it('auto-expands a defaultExpanded running card when output arrives', async () => {
    const current = reactive(tool('f2', 'FetchURL', '{"url":"https://example.com"}', 'running', { defaultExpanded: true }));
    mountTool(WebFetchTool, current);
    await settle();
    expect(isOpen()).toBe(false);

    current.output = ['fetched body'];
    current.status = 'ok';
    await settle();
    expect(isOpen()).toBe(true);
    expect(host.textContent).toContain('fetched body');
  });

  it('passes cancelled status through to the disclosure indicator', async () => {
    mountTool(GenericTool, tool('c1', 'mcp__other__click', '{}', 'cancelled', { output: ['stopped'] }));
    await settle();
    const indicator = host.querySelector('.tl-status.cancelled');
    expect(indicator).not.toBeNull();
    expect(indicator?.querySelector('[data-icon="close"]')).not.toBeNull();
  });
});

describe('refactored tool cards render and interact', () => {
  it('BackgroundTaskTool parses task list and task output fields in zh', async () => {
    mountTool(BackgroundTaskTool, tool('bg1', 'TaskList', '{"active_only":true}', 'ok', {
      output: ['active_background_tasks: 1\n---\ntask_id: t1\ndescription: Build project\nstatus: running\nkind: shell'],
    }), 'zh');
    await settle();
    expect(host.textContent).toContain('1 个任务');
    expect(host.textContent).toContain('Build project');
    expect(host.textContent).toContain('运行中');

    app?.unmount();
    mountTool(BackgroundTaskTool, tool('bg2', 'TaskOutput', '{"task_id":"t9"}', 'ok', {
      output: ['task_id: t9\nstatus: completed\ncommand: pnpm test\nexit_code: 0\n\n[output]\nline 1'],
    }), 'zh');
    await settle();
    expect(host.textContent).toContain('已完成');
    expect(host.textContent).toContain('pnpm test');
    expect(host.textContent).toContain('line 1');
  });

  it('EditTool shows file name and diff stats, opens the file on click', async () => {
    mountTool(EditTool, tool('ed1', 'Edit', JSON.stringify({
      path: '/repo/src/app.ts',
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 2;\nconst c = 3;',
    }), 'ok'));
    await settle();
    expect(host.querySelector('.tl-file')?.textContent).toBe('app.ts');
    expect(host.querySelector('.tl-add')?.textContent).toBe('+2');
    expect(host.querySelector('.tl-del')?.textContent).toBe('−2');

    host.querySelector<HTMLButtonElement>('.tl-file')!.click();
    expect(openFile).toHaveBeenCalledExactlyOnceWith({ path: '/repo/src/app.ts' });
  });

  it('GenericTool translates computer-use fields when expanded', async () => {
    mountTool(GenericTool, tool('gn1', 'mcp__kimi-cu__get_window_state', '{"include_text":true}', 'ok'), 'zh');
    await settle();
    head().click();
    await settle();
    expect([...host.querySelectorAll('.gt-fields dt')].map((n) => n.textContent)).toEqual(['包含文本']);
  });

  it('GlobTool lists files and opens the clicked path', async () => {
    mountTool(GlobTool, tool('gl1', 'Glob', '{"pattern":"**/*.ts","path":"/repo/src"}', 'ok', {
      output: ['/repo/src/a.ts', '/repo/src/b.ts'],
    }));
    await settle();
    expect(host.textContent).toContain('2 files');
    host.querySelectorAll<HTMLElement>('.file-row')[1]!.click();
    expect(openFile).toHaveBeenCalledExactlyOnceWith({ path: '/repo/src/b.ts' });
  });

  it('GrepTool lists matches and opens the clicked path with line number', async () => {
    mountTool(GrepTool, tool('gr1', 'Grep', '{"pattern":"TODO"}', 'ok', {
      output: ['/repo/src/a.ts:12:// TODO fix', 'plain line'],
    }));
    await settle();
    expect(host.textContent).toContain('2 results');
    host.querySelectorAll<HTMLElement>('.match-row')[0]!.click();
    expect(openFile).toHaveBeenCalledExactlyOnceWith({ path: '/repo/src/a.ts', line: 12 });
  });

  it('GoalTool renders create, update with blank-line truncation, and budget headlines', async () => {
    mountTool(GoalTool, tool('go1', 'CreateGoal', '{"objective":"Ship v1","completionCriterion":"All tests pass"}', 'ok'), 'zh');
    await settle();
    expect(host.textContent).toContain('Ship v1');
    expect(host.textContent).toContain('进行中');
    expect(host.textContent).toContain('All tests pass');

    app?.unmount();
    mountTool(GoalTool, tool('go2', 'UpdateGoal', '{"status":"blocked"}', 'ok', {
      output: ['Status updated to blocked.', '', 'Write a concise final message.'],
    }));
    await settle();
    expect(host.textContent).toContain('Blocked');
    expect(host.textContent).toContain('Status updated to blocked.');
    expect(host.textContent).not.toContain('Write a concise final message.');

    app?.unmount();
    mountTool(GoalTool, tool('go3', 'SetGoalBudget', '{"value":5,"unit":"turns"}', 'ok'), 'zh');
    await settle();
    expect(host.textContent).toContain('5 轮');
  });

  it('ReadTool shows line range and opens the file at the start line', async () => {
    mountTool(ReadTool, tool('rd1', 'Read', '{"path":"/repo/src/app.ts","offset":10,"limit":2}', 'ok', {
      output: ['10\tconst a = 1;', '11\tconst b = 2;'],
    }));
    await settle();
    expect(host.textContent).toContain(':10-12');
    host.querySelector<HTMLButtonElement>('.tl-file')!.click();
    expect(openFile).toHaveBeenCalledExactlyOnceWith({ path: '/repo/src/app.ts', line: 10 });
  });

  it('SkillTool shows skill name, args and error output', async () => {
    mountTool(SkillTool, tool('sk1', 'Skill', '{"skill":"write-pr","args":"#1234"}', 'ok'));
    await settle();
    expect(host.textContent).toContain('write-pr');
    expect(host.textContent).toContain('#1234');

    app?.unmount();
    mountTool(SkillTool, tool('sk2', 'Skill', '{"name":"missing"}', 'error', { output: ['Skill not found'] }));
    await settle();
    expect(host.textContent).toContain('Skill not found');
  });

  it('WaitForTool renders waiting, completed details and timed-out running samples', async () => {
    mountTool(WaitForTool, tool('wf1', 'WaitFor', '{"task_id":"task-42"}', 'running'));
    await settle();
    expect(host.textContent).toContain('task-42');

    app?.unmount();
    mountTool(WaitForTool, tool('wf2', 'WaitFor', '{"task_id":"task-42"}', 'ok', {
      output: ['wait_status: completed\ntask_id: task-42\nwaited_ms: 1500\ntimeout_ms: 60000\n\n[finished]\nstatus: completed\ndescription: Build done\n\n[output]\nBuild log line'],
    }));
    await settle();
    expect(host.textContent).toContain('Build done');
    expect(host.textContent).toContain('Build log line');
    expect(host.querySelector('.wf-fields')?.textContent).toContain('task-42');

    app?.unmount();
    mountTool(WaitForTool, tool('wf3', 'WaitFor', '{}', 'ok', {
      output: ['wait_status: timed_out\nwaited_ms: 60000\ntimeout_ms: 60000\n\n[still_running]\nactive_background_tasks: 2\ntask_id: t1\ndescription: Build app\ntask_id: t2\ndescription: Run tests'],
    }), 'zh');
    await settle();
    expect(host.textContent).toContain('等待超时');
    expect(host.textContent).toContain('Build app');
    expect(host.textContent).toContain('Run tests');
  });

  it('WebFetchTool shows URL host and error output', async () => {
    mountTool(WebFetchTool, tool('ft1', 'FetchURL', '{"url":"https://example.com/docs/api"}', 'error', { output: ['404 Not Found'] }));
    await settle();
    expect(host.textContent).toContain('example.com/docs');
    expect(host.textContent).toContain('404 Not Found');
  });
});

describe('task list panels', () => {
  const tasks: TaskItem[] = [
    { id: 'a1', kind: 'subagent', state: 'run', name: 'Explore', durationMs: 1500, agentId: 'agent-1', model: 'kimi-for-coding', thinkingEffort: 'high' },
    { id: 'a2', kind: 'subagent', state: 'run', name: 'Tests', durationMs: 3000, agentId: 'agent-2' },
    { id: 'a3', kind: 'subagent', state: 'cancelled', name: 'Deploy', durationMs: 100 },
  ];

  it.each([
    ['SubagentGrid', SubagentGrid, '.sg-cancel', '.s-cancelled [data-icon="stop"]'],
    ['TasksPane', TasksPane, '.tp-stop', '.tp-cancelled[data-icon="stop"]'],
  ] as const)('%s formats duration and model, disables cancelling rows and emits cancel', async (_name, component, stopSelector, cancelledSelector) => {
    const onCancel = vi.fn();
    const i18n = createI18n({ legacy: false, locale: 'en', fallbackLocale: 'en', messages: JSON.parse(JSON.stringify(messages)) });
    app = createApp({
      setup: () => () => h(component, { tasks, cancellingTaskIds: { a2: true }, onCancel }),
    });
    app.use(i18n);
    app.provide(IconResolverKey, (icon: string) => ({ render: () => h('svg', { 'data-icon': icon }) }));
    app.provide(panelApiKey, { openFile, openAgent });
    app.provide(ModelDisplayKey, (alias?: string) => alias?.toUpperCase());
    app.provide(SubagentEffortKey, (effort?: string) => effort ? `Effort:${effort}` : undefined);
    app.mount(host);
    await settle();

    expect(host.textContent).toContain('KIMI-FOR-CODING');
    expect(host.textContent).toContain('Effort:high');
    expect(host.textContent).toContain('1s');
    expect(host.querySelector(cancelledSelector)).not.toBeNull();

    const buttons = host.querySelectorAll<HTMLButtonElement>(stopSelector);
    expect(buttons[0]!.disabled).toBe(false);
    expect(buttons[1]!.disabled).toBe(true);
    buttons[1]!.click();
    expect(onCancel).not.toHaveBeenCalled();
    buttons[0]!.click();
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('a1');
  });
});
