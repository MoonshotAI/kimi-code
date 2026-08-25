import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { i18n } from '../../src/renderer/i18n';
import {
  summarizeActivity,
  summarizeLive,
  type ActivitySummaryItem,
  type SummaryClause,
} from '@moonshot-ai/app-components';

function tool(name: string, over: Partial<{ arg: string; status: 'ok' | 'running' | 'error' }> = {}): ActivitySummaryItem {
  return { kind: 'tool', tool: { name, arg: over.arg ?? '{}', status: over.status ?? 'ok' } };
}

const thinking: ActivitySummaryItem = { kind: 'thinking' };

/** Debug view: "text|text(danger)|text(faint)" per clause, clauses joined by " · ". */
function render(clauses: SummaryClause[]): string {
  return clauses
    .map((c) =>
      c.fragments.map((f) => (f.tone === 'normal' ? f.text : `${f.text}(${f.tone})`)).join(''),
    )
    .join(' · ');
}

beforeAll(() => {
  i18n.global.locale.value = 'zh';
  setKimiClientDeps({
    api: () => {
      throw new Error('api is not used by these tests');
    },
    t: (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params)),
  });
});

afterAll(() => {
  resetKimiClientDeps();
});

describe('summarizeActivity', () => {
  it('aggregates per kind in first-appearance order', () => {
    const s = summarizeActivity([tool('read'), tool('bash'), tool('read'), tool('grep'), tool('bash')]);
    expect(render(s.clauses)).toBe('读取了 2 个文件 · 运行了 2 条命令 · 搜索了 1 个模式');
    expect(s.hasError).toBe(false);
  });

  it('normalizes tool names and folds multi_edit into edit', () => {
    const s = summarizeActivity([tool('Read'), tool('edit'), tool('MultiEdit'), tool('write'), tool('shell')]);
    expect(render(s.clauses)).toBe('读取了 1 个文件 · 编辑了 2 处 · 写入了 1 个文件 · 运行了 1 条命令');
  });

  it('attaches the failure clause to its own kind, marked danger', () => {
    const s = summarizeActivity([tool('read'), tool('bash'), tool('bash', { status: 'error' })]);
    const bash = s.clauses[1];
    expect(bash?.fragments).toEqual([
      { text: '运行了 2 条命令', tone: 'normal' },
      { text: '（1 失败）', tone: 'danger' },
    ]);
    expect(s.hasError).toBe(true);
  });

  it('never narrates thinking items — they fold in but carry no clause', () => {
    const s = summarizeActivity([tool('read'), thinking, thinking]);
    expect(render(s.clauses)).toBe('读取了 1 个文件');
  });

  it('appends the duration faint when given', () => {
    const s = summarizeActivity([tool('read')], { durationMs: 26_800 });
    expect(s.clauses.at(-1)?.fragments).toEqual([{ text: '26s', tone: 'faint' }]);
  });

  it('omits a sub-second duration', () => {
    const s = summarizeActivity([tool('read')], { durationMs: 400 });
    expect(render(s.clauses)).toBe('读取了 1 个文件');
  });

  it('falls back to the generic counter for unknown kinds', () => {
    const s = summarizeActivity([tool('frobnicate'), tool('frobnicate')]);
    expect(render(s.clauses)).toBe('执行了 2 次工具调用');
  });

  it('joins everything into a flat plain string for the tooltip', () => {
    const s = summarizeActivity(
      [tool('read'), tool('read'), tool('bash', { status: 'error' }), thinking],
      { durationMs: 1500 },
    );
    expect(s.plain).toBe('读取了 2 个文件 · 运行了 1 条命令（1 失败） · 1s');
  });
});

describe('summarizeLive', () => {
  it('leads with the current action using the tool argument as subject', () => {
    const current = tool('read', { arg: '{"path":"src/ActivityRun.vue"}', status: 'running' });
    const s = summarizeLive([tool('read'), tool('grep'), current], current);
    expect(render([s.current!])).toBe('正在读取 src/ActivityRun.vue');
    expect(render(s.done)).toBe('已读取了 1 个文件(faint) · 已搜索了 1 个模式(faint)');
  });

  it('uses the thinking streaming label when the current item is thinking', () => {
    const s = summarizeLive([tool('bash')], thinking);
    expect(render([s.current!])).toBe('思考中…');
    expect(render(s.done)).toBe('已运行了 1 条命令(faint)');
  });

  it('aggregates everything when nothing is currently running', () => {
    const s = summarizeLive([tool('read'), tool('read')], null);
    expect(s.current).toBeNull();
    expect(render(s.done)).toBe('已读取了 2 个文件(faint)');
  });

  it('excludes other in-flight tools from the done stats (parallel calls)', () => {
    const current = tool('bash', { arg: '{"command":"sleep 1"}', status: 'running' });
    const s = summarizeLive(
      [tool('bash'), tool('read', { status: 'running' }), current],
      current,
    );
    // The settled bash counts; the other running read does not.
    expect(render(s.done)).toBe('已运行了 1 条命令(faint)');
  });

  it('keeps failure clauses in the live done stats', () => {
    const current = tool('grep', { arg: '{"pattern":"foo"}', status: 'running' });
    const s = summarizeLive([tool('bash', { status: 'error' }), current], current);
    expect(s.done[0]?.fragments).toEqual([
      { text: '已运行了 1 条命令', tone: 'faint' },
      { text: '（1 失败）', tone: 'danger' },
    ]);
  });

  it('composes the plain text from current + done', () => {
    const current = tool('bash', { arg: '{"command":"pnpm test"}', status: 'running' });
    const s = summarizeLive([tool('read'), current], current);
    expect(s.plain).toBe('正在运行 pnpm test · 已读取了 1 个文件');
  });

  it('degrades to a busy note when the current tool has no usable subject', () => {
    const current = tool('read', { arg: '{}', status: 'running' });
    const s = summarizeLive([], current);
    expect(render([s.current!])).toBe('正在执行…');
  });

  it('uses the bare path as the live subject of an in-flight write', () => {
    const current = tool('write', { arg: '{"path":"docs/new.md"}', status: 'running' });
    const s = summarizeLive([], current);
    expect(render([s.current!])).toBe('正在写入 docs/new.md');
  });

  it('drops the prefix in English', () => {
    i18n.global.locale.value = 'en';
    try {
      const current = tool('read', { arg: '{"path":"a.ts"}', status: 'running' });
      const s = summarizeLive([tool('bash', { status: 'error' }), current], current);
      expect(render([s.current!])).toBe('Reading a.ts');
      expect(s.done[0]?.fragments).toEqual([
        { text: 'Ran 1 command', tone: 'faint' },
        { text: ' (1 failed)', tone: 'danger' },
      ]);
    } finally {
      i18n.global.locale.value = 'zh';
    }
  });

  it('pluralizes English clauses by count (runs of one are common now)', () => {
    i18n.global.locale.value = 'en';
    try {
      expect(render(summarizeActivity([tool('read')]).clauses)).toBe('Read 1 file');
      expect(render(summarizeActivity([tool('read'), tool('read')]).clauses)).toBe('Read 2 files');
      // Edits count edit operations, not files — two edits to one file are
      // still "Made 2 edits".
      expect(render(summarizeActivity([tool('edit'), tool('multi_edit')]).clauses)).toBe('Made 2 edits');
    } finally {
      i18n.global.locale.value = 'zh';
    }
  });
});
