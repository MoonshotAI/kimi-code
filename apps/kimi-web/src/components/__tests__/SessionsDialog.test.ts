// apps/kimi-web/src/components/__tests__/SessionsDialog.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import SessionsDialog from '../SessionsDialog.vue';
import type { Session, WorkspaceGroup } from '../../types';

// SessionsDialog uses vue-i18n; install the plugin. Default locale is English.
const global = { plugins: [i18n] };

const sessions: Session[] = [
  { id: 's1', title: 'Refactor auth flow', time: '2h ago', status: 'idle' },
  { id: 's2', title: 'Fix login bug', time: 'just now', status: 'running' },
  { id: 's3', title: 'Write docs', time: '1d ago', status: 'idle' },
];

const workspaceGroups: WorkspaceGroup[] = [
  {
    workspace: { id: 'w1', name: 'kimi-web', root: '/code/kimi-web', shortPath: '~/code/kimi-web', sessionCount: 2 },
    sessions: [sessions[0]!, sessions[1]!],
  },
  {
    workspace: { id: 'w2', name: 'docs-site', root: '/code/docs', shortPath: '~/code/docs', sessionCount: 1 },
    sessions: [sessions[2]!],
  },
];

const attentionBySession: Record<string, number> = { s2: 1 };

function mountDialog() {
  return mount(SessionsDialog, {
    props: { sessions, workspaceGroups, attentionBySession, activeId: 's1' },
    global,
  });
}

describe('SessionsDialog', () => {
  it('为每个会话渲染一行', () => {
    const w = mountDialog();
    const rows = w.findAll('.session-row');
    expect(rows.length).toBe(sessions.length);
    const text = w.text();
    expect(text).toContain('Refactor auth flow');
    expect(text).toContain('Fix login bug');
    expect(text).toContain('Write docs');
  });

  it('行内显示所属工作区名称', () => {
    const w = mountDialog();
    const text = w.text();
    expect(text).toContain('kimi-web');
    expect(text).toContain('docs-site');
  });

  it('有待处理事项时显示 attention 徽章', () => {
    const w = mountDialog();
    // Only s2 has attention (count 1)
    const badges = w.findAll('.attn-badge');
    expect(badges.length).toBe(1);
    expect(badges[0]!.text()).toBe('1');
  });

  it('搜索按标题过滤（不区分大小写）', async () => {
    const w = mountDialog();
    await w.get('.search-input').setValue('LOGIN');
    const rows = w.findAll('.session-row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain('Fix login bug');
  });

  it('搜索清空后显示全部会话', async () => {
    const w = mountDialog();
    const input = w.get('.search-input');
    await input.setValue('login');
    expect(w.findAll('.session-row').length).toBe(1);
    await input.setValue('');
    expect(w.findAll('.session-row').length).toBe(sessions.length);
  });

  it('点击一行发出带 id 的 select 事件', async () => {
    const w = mountDialog();
    const rows = w.findAll('.session-row');
    await rows[2]!.trigger('click');
    expect(w.emitted('select')).toBeTruthy();
    expect(w.emitted('select')![0]).toEqual(['s3']);
  });

  it('搜索无结果时显示提示', async () => {
    const w = mountDialog();
    await w.get('.search-input').setValue('zzzzznonexistent');
    expect(w.findAll('.session-row').length).toBe(0);
    expect(w.text()).toContain('No matching sessions');
  });

  it('点击关闭按钮发出 close 事件', async () => {
    const w = mountDialog();
    await w.get('.close-btn').trigger('click');
    expect(w.emitted('close')).toBeTruthy();
  });

  it('头部显示会话数量', () => {
    const w = mountDialog();
    expect(w.get('.count').text()).toBe(String(sessions.length));
  });
});
