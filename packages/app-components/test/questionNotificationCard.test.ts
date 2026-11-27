// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { TaskNotification } from '@moonshot-ai/app-core/client/types';
import NotificationCard from '../src/chat/NotificationCard.vue';

const QUESTION = 'core 修复需要基于最新 origin/main，你希望在哪里实施？';
const LONG_ANSWER = '在当前 worktree 中基于最新 origin/main 修复。'.repeat(20);

function questionNotification(answer: string, type = 'task.completed'): TaskNotification {
  return {
    id: 'task:question-2fi9py5i:completed',
    type,
    sourceKind: 'background_task',
    sourceId: 'question-2fi9py5i',
    title: 'Background question answered',
    severity: 'info',
    body: `The user answered "${QUESTION}".`,
    questionAnswer: type !== 'task.completed'
      ? undefined
      : answer === ''
        ? { answers: {}, note: 'User dismissed the question without answering.' }
        : { answers: { [QUESTION]: answer }, note: '' },
    raw: '{}',
  };
}

const BASH: TaskNotification = {
  id: 'task:bash-1:completed',
  type: 'task.completed',
  sourceKind: 'background_task',
  sourceId: 'bash-1',
  title: 'Background process completed',
  severity: 'info',
  body: 'pnpm build completed.',
  raw: '{}',
};

let app: App | null = null;
let host: HTMLDivElement;

function mount(items: TaskNotification[], locale: 'zh' | 'en' = 'zh') {
  app = createApp({
    setup: () => () => h(NotificationCard, { items }),
  });
  app.use(createKimiI18n({ locale }));
  app.provide(IconResolverKey, name => ({ render: () => h('svg', { 'data-icon': name }) }));
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
});

describe('background question answer receipts', () => {
  it('reuses the foreground Q/A receipt without a raw payload disclosure', async () => {
    mount([{ ...questionNotification('在当前 worktree 中修复'), createdAt: '2026-10-29T05:23:00.000Z' }]);
    await nextTick();

    expect(host.querySelector('.ntn.question .tool-line.open')).not.toBeNull();
    expect(host.querySelector('.ntn-bubble')).toBeNull();
    expect(host.querySelector('.tl-name')?.textContent).toBe('用户回答收集');
    expect(host.querySelector('.rc-qtext')?.textContent).toBe(QUESTION);
    expect(host.querySelector('.rc-answer')?.textContent).toBe('在当前 worktree 中修复');
    expect(host.querySelector('.qnr-raw')).toBeNull();
    expect(host.textContent).not.toContain('由后台发送');
    expect(host.textContent).not.toContain('原始 payload');

    (host.querySelector('.tl-head') as HTMLElement).click();
    await nextTick();
    expect(host.querySelector('.tool-line')?.classList.contains('open')).toBe(false);
    (host.querySelector('.tl-head') as HTMLElement).click();
    await nextTick();
    expect(host.querySelector('.tool-line')?.classList.contains('open')).toBe(true);
  });

  it('renders long answers with the foreground receipt without truncation', async () => {
    mount([questionNotification(LONG_ANSWER)]);
    await nextTick();

    expect(host.querySelector('.rc-answer')?.textContent).toBe(LONG_ANSWER);
    expect(host.querySelector('.rc-answer')?.classList.contains('clamped')).toBe(false);
    expect(host.querySelector('.qnr-expand')).toBeNull();
  });

  it('uses neutral unanswered and cancelled states', async () => {
    mount([questionNotification(''), questionNotification('', 'task.killed')]);
    await nextTick();

    const titles = [...host.querySelectorAll('.tl-name')].map(el => el.textContent);
    expect(titles).toEqual(['后台提问未回答', '后台提问已取消']);
    expect(host.querySelector('.rc-list')).toBeNull();
    expect(host.querySelectorAll('.ntn-bubble')).toHaveLength(0);
  });

  it('renders ordinary background notifications as left-aligned tool disclosures', async () => {
    mount([
      {
        ...BASH,
        body: 'Wall time: 47.461 seconds\nRun gh auth login device flow and wait for browser authorization completed.',
        createdAt: '2026-10-29T05:23:00.000Z',
        outputFile: {
          path: '/Users/demo/.kimi/sessions/019a7c40/agents/main/tasks/bash-wcoonksc/output.log',
          bytes: 787,
        },
      },
    ]);
    await nextTick();

    expect(host.querySelector('.ntn.question')).toBeNull();
    expect(host.querySelector('.ntn-bubble')).toBeNull();
    expect(host.querySelector('.ntn .tool-line')).not.toBeNull();
    expect(host.querySelector('[data-icon="terminal"]')).not.toBeNull();
    expect(host.querySelector('.tl-name')?.textContent).toBe('后台 Bash');
    expect(host.querySelector('.tl-dim')?.textContent).toBe(
      'Run gh auth login device flow and wait for browser authorization',
    );
    expect(host.querySelector('.tl-faint')?.textContent).toBe('已完成');
    expect(host.querySelector('.tl-chip')?.textContent).toBe('47 秒');
    expect(host.querySelector('.ntn-sr-only')?.textContent).toBe('由后台发送（Bash）');
    expect(host.textContent).not.toContain('Wall time:');
    expect(host.textContent).not.toContain('原始 payload');

    (host.querySelector('.tl-head') as HTMLElement).click();
    await nextTick();
    expect(host.querySelector('.tool-line')?.classList.contains('open')).toBe(true);
    expect(host.querySelector('.tp-title')?.textContent).toBe('输出日志');
    expect(host.querySelector('.tp-meta')?.textContent).toBe('bash-wcoonksc/output.log · 787 B');
    expect(host.querySelector('.ntn-dl .msg-time')?.textContent?.trim()).not.toBe('');
  });

  it('preserves English status and provenance text for background task notifications', async () => {
    mount(
      [
        {
          id: 'task:bash-e2e:completed',
          type: 'task.completed',
          sourceKind: 'background_task',
          sourceId: 'bash-e2e',
          title: 'Background process completed',
          severity: 'info',
          body: 'Wall time: 2.100 seconds\nLong job completed.',
          raw: '{}',
        },
        {
          id: 'task:agent-1:failed',
          type: 'task.failed',
          sourceKind: 'subagent',
          sourceId: 'agent-1',
          agentId: 'agent-1',
          title: 'Background agent failed',
          severity: 'warning',
          body: 'Wall time: 12.400 seconds\nExplore repo failed. Reason: timeout',
          outputPreview: { text: 'stack line 1\nstack line 2', bytes: 25, truncated: true },
          raw: '{}',
        },
      ],
      'en',
    );
    await nextTick();

    const statuses = [...host.querySelectorAll('.ntn')];
    expect(statuses).toHaveLength(2);
    expect(statuses[0]?.textContent).toContain('From background (Bash)');
    expect(statuses[0]?.textContent).toContain('Completed');
    expect(statuses[0]?.querySelector('.tl-dim')?.textContent).toBe('Long job');
    expect(statuses[0]?.querySelector('.tl-chip')?.textContent).toBe('2s');
    expect(statuses[1]?.querySelector('.tl-chip')?.textContent).toBe('12s');

    expect(statuses[1]?.querySelector('[data-icon="robot"]')).not.toBeNull();
    expect(statuses[1]?.querySelector('.tl-name')?.textContent).toBe('Background Agent');
    expect(statuses[1]?.querySelector('.tl-faint')?.textContent).toBe('Failed');
    expect(statuses[1]?.querySelector('.tl-status.error')).not.toBeNull();
    expect(statuses[1]?.textContent).toContain('stack line 1');
  });

  it('surfaces warning state for warning-severity notifications with unknown type', async () => {
    mount([
      {
        id: 'notice:warn-1',
        type: 'task.custom_notice',
        sourceKind: 'background_task',
        sourceId: 'bash-warn',
        title: 'Rate limit approaching',
        severity: 'warning',
        body: 'Retrying in 15s',
        raw: '{}',
      },
    ]);
    await nextTick();

    const row = host.querySelector('.ntn.warn');
    expect(row).not.toBeNull();
    expect(row?.querySelector('.ntn-warn-label')?.textContent).toBe('通知');
    expect(row?.querySelector('.ntn-warn-ico [data-icon="alert-triangle"]')).not.toBeNull();
  });
});
