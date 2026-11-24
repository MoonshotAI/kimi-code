import { beforeAll, describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { Translator } from '../src/contracts';
import {
  summarizeActivity,
  summarizeLive,
  type ActivityClauseProvider,
  type ActivitySummaryItem,
  type SummaryClause,
} from '../src/lib/activitySummary';

const i18n = createKimiI18n({ locale: 'zh' });
const t: Translator = (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params));

function tool(name: string, over: Partial<{ arg: string; status: 'ok' | 'running' | 'error' }> = {}): ActivitySummaryItem {
  return { kind: 'tool', tool: { name, arg: over.arg ?? '{}', status: over.status ?? 'ok' } };
}

const thinking: ActivitySummaryItem = { kind: 'thinking' };

function render(clauses: SummaryClause[]): string {
  return clauses
    .map((c) =>
      c.fragments.map((f) => (f.tone === 'normal' ? f.text : `${f.text}(${f.tone})`)).join(''),
    )
    .join(' · ');
}

beforeAll(() => {
  i18n.global.locale.value = 'zh';
});

describe('summarizeActivity', () => {
  it('aggregates per kind in first-appearance order', () => {
    const s = summarizeActivity(t, [tool('read'), tool('bash'), tool('read'), tool('grep'), tool('bash')]);
    expect(render(s.clauses)).toBe('读取了 2 个文件 · 运行了 2 条命令 · 搜索了 1 个模式');
    expect(s.hasError).toBe(false);
  });

  it('normalizes tool names and folds multi_edit into edit', () => {
    const s = summarizeActivity(t, [tool('Read'), tool('edit'), tool('MultiEdit'), tool('write'), tool('shell')]);
    expect(render(s.clauses)).toBe('读取了 1 个文件 · 编辑了 2 处 · 写入了 1 个文件 · 运行了 1 条命令');
  });

  it('attaches the failure clause to its own kind in the same tone', () => {
    const s = summarizeActivity(t, [tool('read'), tool('bash'), tool('bash', { status: 'error' })]);
    const bash = s.clauses[1];
    expect(bash?.fragments).toEqual([
      { text: '运行了 2 条命令', tone: 'normal' },
      { text: '（1 失败）', tone: 'normal' },
    ]);
    expect(s.hasError).toBe(true);
  });

  it('never narrates thinking items — they fold in but carry no clause', () => {
    const s = summarizeActivity(t, [tool('read'), thinking, thinking]);
    expect(render(s.clauses)).toBe('读取了 1 个文件');
  });

  it('appends the duration faint when given', () => {
    const s = summarizeActivity(t, [tool('read')], { durationMs: 26_800 });
    expect(s.clauses.at(-1)?.fragments).toEqual([{ text: '26s', tone: 'faint' }]);
  });

  it('omits a sub-second duration', () => {
    const s = summarizeActivity(t, [tool('read')], { durationMs: 400 });
    expect(render(s.clauses)).toBe('读取了 1 个文件');
  });

  it('falls back to the generic counter for unknown kinds', () => {
    const s = summarizeActivity(t, [tool('frobnicate'), tool('frobnicate')]);
    expect(render(s.clauses)).toBe('执行了 2 次工具调用');
  });

  it('merges distinct untyped tools into one counter at the first position', () => {
    const s = summarizeActivity(t, [
      tool('read'),
      tool('mcp__kimi-cu__list_windows'),
      tool('bash'),
      tool('mcp__other__a', { status: 'error' }),
      tool('frobnicate'),
    ]);
    expect(render(s.clauses)).toBe('读取了 1 个文件 · 执行了 3 次工具调用（1 失败） · 运行了 1 条命令');
  });

  it('joins everything into a flat plain string for the tooltip', () => {
    const s = summarizeActivity(t, 
      [tool('read'), tool('read'), tool('bash', { status: 'error' }), thinking],
      { durationMs: 1500 },
    );
    expect(s.plain).toBe('读取了 2 个文件 · 运行了 1 条命令（1 失败） · 1s');
  });
});

describe('summarizeLive', () => {
  it('leads with the current action using the tool argument as subject', () => {
    const current = tool('read', { arg: '{"path":"src/ActivityRun.vue"}', status: 'running' });
    const s = summarizeLive(t, [tool('read'), tool('grep'), current], current);
    expect(render([s.current!])).toBe('正在读取 src/ActivityRun.vue');
    expect(render(s.done)).toBe('已读取了 1 个文件(faint) · 已搜索了 1 个模式(faint)');
  });

  it('uses the thinking streaming label when the current item is thinking', () => {
    const s = summarizeLive(t, [tool('bash')], thinking);
    expect(render([s.current!])).toBe('思考中…');
    expect(render(s.done)).toBe('已运行了 1 条命令(faint)');
  });

  it('aggregates everything when nothing is currently running', () => {
    const s = summarizeLive(t, [tool('read'), tool('read')], null);
    expect(s.current).toBeNull();
    expect(render(s.done)).toBe('已读取了 2 个文件(faint)');
  });

  it('excludes other in-flight tools from the done stats (parallel calls)', () => {
    const current = tool('bash', { arg: '{"command":"sleep 1"}', status: 'running' });
    const s = summarizeLive(t, 
      [tool('bash'), tool('read', { status: 'running' }), current],
      current,
    );
    expect(render(s.done)).toBe('已运行了 1 条命令(faint)');
  });

  it('keeps failure clauses in the live done stats', () => {
    const current = tool('grep', { arg: '{"pattern":"foo"}', status: 'running' });
    const s = summarizeLive(t, [tool('bash', { status: 'error' }), current], current);
    expect(s.done[0]?.fragments).toEqual([
      { text: '已运行了 1 条命令', tone: 'faint' },
      { text: '（1 失败）', tone: 'faint' },
    ]);
  });

  it('composes the plain text from current + done', () => {
    const current = tool('bash', { arg: '{"command":"pnpm test"}', status: 'running' });
    const s = summarizeLive(t, [tool('read'), current], current);
    expect(s.plain).toBe('正在运行命令 · 已读取了 1 个文件');
  });

  it('uses a generic label for a running command without the command line', () => {
    const current = tool('bash', { arg: '{"command":"find / -name HANDOVER"}', status: 'running' });
    expect(render([summarizeLive(t, [current], current).current!])).toBe('正在运行命令');
    i18n.global.locale.value = 'en';
    try {
      expect(render([summarizeLive(t, [current], current).current!])).toBe('Running a command');
    } finally {
      i18n.global.locale.value = 'zh';
    }
  });

  it('keeps the action label when the current tool has no usable subject', () => {
    const current = tool('read', { arg: '{}', status: 'running' });
    expect(render([summarizeLive(t, [], current).current!])).toBe('正在读取…');
    const unknown = tool('frobnicate', { status: 'running' });
    expect(render([summarizeLive(t, [], unknown).current!])).toBe('正在执行…');
  });

  it('uses a workspace-relative path as the live subject of an in-flight write', () => {
    const current = tool('write', { arg: '{"path":"docs/new.md"}', status: 'running' });
    const s = summarizeLive(t, [], current);
    expect(render([s.current!])).toBe('正在写入 docs/new.md');
  });

  it('shortens an absolute path to its filename and keeps the full path in the tooltip', () => {
    const current = tool('write', { arg: '{"path":"/Users/moonshot/project/docs/new.md"}', status: 'running' });
    const s = summarizeLive(t, [tool('read'), current], current);
    expect(render([s.current!])).toBe('正在写入 new.md');
    expect(s.plain).toBe('正在写入 /Users/moonshot/project/docs/new.md · 已读取了 1 个文件');
  });

  it('shows only the action while tool arguments are incomplete JSON', () => {
    const current = tool('write', { arg: '{"path":"/Users/moonshot/project/docs/new', status: 'running' });
    const s = summarizeLive(t, [], current);
    expect(render([s.current!])).toBe('正在写入…');
    expect(s.plain).toBe('正在写入…');
  });

  it.each([
    ['write', 'content', '正在写入'],
    ['edit', 'old_string', '正在编辑'],
  ])('uses the completed path of an in-flight %s before its content finishes', (name, field, action) => {
    const current = tool(name, { arg: `{"path":"/Users/moonshot/project/docs/new.md","${field}":"unfinished`, status: 'running' });
    const s = summarizeLive(t, [], current);
    expect(render([s.current!])).toBe(`${action} new.md`);
    expect(s.plain).toBe(`${action} /Users/moonshot/project/docs/new.md`);
  });

  it('uses the FetchURL host instead of raw JSON', () => {
    const current = tool('FetchURL', { arg: '{"url":"https://api.npmjs.org/downloads/point/last-week/partial-json"}', status: 'running' });
    expect(render([summarizeLive(t, [], current).current!])).toBe('正在抓取 api.npmjs.org/downloads');
  });

  it('keeps a readable subject that starts with a brace', () => {
    const current = tool('grep', { arg: '{"pattern":"{foo}"}', status: 'running' });
    expect(render([summarizeLive(t, [], current).current!])).toBe('正在搜索 {foo}');
  });

  it('drops the prefix in English', () => {
    i18n.global.locale.value = 'en';
    try {
      const current = tool('read', { arg: '{"path":"a.ts"}', status: 'running' });
      const s = summarizeLive(t, [tool('bash', { status: 'error' }), current], current);
      expect(render([s.current!])).toBe('Reading a.ts');
      expect(s.done[0]?.fragments).toEqual([
        { text: 'Ran 1 command', tone: 'faint' },
        { text: ' (1 failed)', tone: 'faint' },
      ]);
      const pending = tool('write', { arg: '{"path":"docs/new', status: 'running' });
      expect(render([summarizeLive(t, [], pending).current!])).toBe('Writing…');
    } finally {
      i18n.global.locale.value = 'zh';
    }
  });

  it('pluralizes English clauses by count (runs of one are common now)', () => {
    i18n.global.locale.value = 'en';
    try {
      expect(render(summarizeActivity(t, [tool('read')]).clauses)).toBe('Read 1 file');
      expect(render(summarizeActivity(t, [tool('read'), tool('read')]).clauses)).toBe('Read 2 files');
      expect(render(summarizeActivity(t, [tool('edit'), tool('multi_edit')]).clauses)).toBe('Made 2 edits');
    } finally {
      i18n.global.locale.value = 'zh';
    }
  });
});

describe('clause providers', () => {
  const provider: ActivityClauseProvider = {
    kind: 'browser',
    done: (tools, live) => tools.length > 1
      ? [{ fragments: [{ text: `pages ${tools.length}`, tone: live ? 'faint' : 'normal' }] }, { fragments: [{ text: 'clicks', tone: 'normal' }] }]
      : undefined,
    doing: (current, finished) => current.arg === '{}' ? undefined : `doing ${current.arg} after ${finished.length}`,
    tail: (tools) => tools.some((item) => item.status === 'error') ? { fragments: [{ text: 'retried', tone: 'faint' }] } : undefined,
    detail: (tools) => `all ${tools.length}`,
  };
  const browser = (over: Partial<{ arg: string; status: 'ok' | 'running' | 'error' }> = {}) => tool('mcp__desktop_browser__run', over);

  it('lets a provider replace its kind with several clauses and keeps the other kinds', () => {
    const s = summarizeActivity(t, [browser(), tool('read'), browser({ status: 'error' })], { durationMs: 2000, providers: [provider] });
    expect(render(s.clauses)).toBe('pages 2 · clicks · 读取了 1 个文件 · retried(faint) · 2s(faint)');
    expect(s.hasError).toBe(true);
    expect(s.detail).toBe('all 2');
    expect(s.plain).toBe('pages 2 · clicks · 读取了 1 个文件 · retried · 2s');
  });

  it('falls back to the default clause when the provider declines', () => {
    const s = summarizeActivity(t, [browser({ status: 'error' })], { providers: [provider] });
    expect(render(s.clauses)).toBe('执行了 1 次浏览器操作（1 失败） · retried(faint)');
    expect(summarizeActivity(t, [browser()]).detail).toBeUndefined();
  });

  it('lets a provider narrate the current call and the finished calls while live', () => {
    const current = browser({ arg: '{"operation":"click"}', status: 'running' });
    const s = summarizeLive(t, [browser(), browser(), tool('read'), current], current, [provider]);
    expect(render([s.current!])).toBe('doing {"operation":"click"} after 2');
    expect(render(s.done)).toBe('pages 2(faint) · clicks · 已读取了 1 个文件(faint)');
    expect(s.detail).toBe('all 3');
    const bare = browser({ status: 'running' });
    expect(render([summarizeLive(t, [bare], bare, [provider]).current!])).toBe('正在操作浏览器');
  });
});
