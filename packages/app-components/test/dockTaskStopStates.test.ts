// @vitest-environment jsdom
import { createApp, h, nextTick, type App, type Component } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { ModelDisplayKey, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import type { TaskItem } from '@moonshot-ai/app-core/client/types';
import TasksPane from '../src/chat/dock/TasksPane.vue';
import SubagentGrid from '../src/chat/dock/SubagentGrid.vue';

let app: App | null = null;
let host: HTMLDivElement | null = null;

function task(id: string, state: TaskItem['state'], kind = 'bash'): TaskItem {
  return { id, kind, state, name: `Task ${id}`, timing: '', durationMs: 1000 };
}

async function mount(component: Component, kind: string): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () => h(component, {
      tasks: [task('run-1', 'run', kind), task('run-2', 'run', kind), task('done', 'done', kind), task('fail', 'fail', kind), task('stopped', 'cancelled', kind)],
      cancellingTaskIds: { 'run-2': true },
    }),
  });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.provide(panelApiKey, undefined);
  app.provide(ModelDisplayKey, undefined);
  app.provide(SubagentEffortKey, undefined);
  app.mount(host);
  await nextTick();
}

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
});

describe('background task stop states', () => {
  it('uses a square stop action and one disabled spinner in the Bash list', async () => {
    await mount(TasksPane, 'bash');
    const buttons = host!.querySelectorAll<HTMLButtonElement>('.tp-stop');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.querySelector('[data-icon="stop"]')).not.toBeNull();
    expect(buttons[0]!.disabled).toBe(false);
    expect(buttons[1]!.querySelector('.ui-spinner')).not.toBeNull();
    expect(buttons[1]!.querySelector('[data-icon]')).toBeNull();
    expect(buttons[1]!.disabled).toBe(true);
    expect(host!.querySelector('.tp-done[data-icon="circle-check"]')).not.toBeNull();
    expect(host!.querySelector('.tp-fail[data-icon="close"]')).not.toBeNull();
    expect(host!.querySelector('.tp-cancelled[data-icon="stop"]')).not.toBeNull();
  });

  it('uses the same icons in subagent cards without changing their status text', async () => {
    await mount(SubagentGrid, 'subagent');
    const buttons = host!.querySelectorAll<HTMLButtonElement>('.sg-cancel');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.querySelector('[data-icon="stop"]')).not.toBeNull();
    expect(buttons[0]!.disabled).toBe(false);
    expect(buttons[1]!.querySelector('.ui-spinner')).not.toBeNull();
    expect(buttons[1]!.querySelector('[data-icon]')).toBeNull();
    expect(buttons[1]!.disabled).toBe(true);
    expect(host!.querySelector('.s-done [data-icon="circle-check"]')).not.toBeNull();
    expect(host!.querySelector('.s-fail [data-icon="close"]')).not.toBeNull();
    expect(host!.querySelector('.s-cancelled [data-icon="stop"]')).not.toBeNull();
    expect(host!.querySelector('.s-cancelled .sg-state')?.textContent).toContain('已停止');
    expect(host!.querySelector('.s-fail .sg-state')?.textContent).toContain('失败');
  });
});
