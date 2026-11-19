import { describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { Translator } from '../src/contracts';
import { toolSummary } from '../src/lib/toolText';

function translator(locale: 'en' | 'zh'): Translator {
  const i18n = createKimiI18n({ locale });
  return (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params));
}

const en = translator('en');
const zh = translator('zh');

describe('toolSummary web fetch', () => {
  it('shows the host and first path segment for FetchURL instead of raw JSON', () => {
    expect(toolSummary(zh, 'FetchURL', '{"url":"https://api.npmjs.org/downloads/point/last-week/partial-json"}')).toBe('api.npmjs.org/downloads');
  });
});

describe('toolSummary cron tools', () => {
  it('summarizes CronCreate as only the human schedule, without the prompt or cron syntax', () => {
    const arg = '{"cron":"44 15 19 9 *","prompt":"check the deploy"}';
    expect(toolSummary(en, 'CronCreate', arg)).toBe('Yearly on Sep 19 at 15:44');
    expect(toolSummary(zh, 'CronCreate', arg)).toBe('每年 9月19日 15:44');
    expect(toolSummary(en, 'CronCreate', '{"cron":"*/5 * * * *","prompt":"check"}')).toBe('Every 5 minutes');
    expect(toolSummary(zh, 'CronCreate', '{"cron":"*/5 * * * *","prompt":"check"}')).toBe('每 5 分钟');
  });

  it('humanizes a pinned one-shot datetime without the prompt', () => {
    const arg = '{"cron":"49 18 19 9 *","prompt":"check","recurring":false}';
    expect(toolSummary(en, 'CronCreate', arg)).toBe('Sep 19 at 18:49');
    expect(toolSummary(zh, 'CronCreate', arg)).toBe('9月19日 18:49');
  });

  it('returns an empty CronCreate summary when no pattern matches', () => {
    expect(toolSummary(en, 'CronCreate', '{"cron":"0 9 * * 1,3","prompt":"check"}')).toBe('');
    expect(toolSummary(en, 'CronCreate', '{"cron":"0 9 * * *","prompt":"check","recurring":false}')).toBe('');
  });

  it('shows the complete CronCreate args in expanded mode', () => {
    const arg = '{"cron":"0 9 * * *","prompt":"check the deploy","recurring":false}';
    expect(toolSummary(en, 'CronCreate', arg, true)).toBe(arg);
  });

  it('returns an empty summary for CronList without args', () => {
    expect(toolSummary(en, 'CronList', '')).toBe('');
    expect(toolSummary(en, 'CronList', '{}')).toBe('');
  });

  it('shows no job id in the CronDelete strip but keeps it in expanded mode', () => {
    expect(toolSummary(en, 'CronDelete', '{"id":"01K5Z8HV3Q"}')).toBe('');
    expect(toolSummary(en, 'CronDelete', '{"id":"01K5Z8HV3Q"}', true)).toBe('{"id":"01K5Z8HV3Q"}');
  });
});

describe('toolSummary skill tool', () => {
  it('shows the skill name and args instead of raw JSON', () => {
    const arg = '{"skill":"lark-doc","args":"https://example.com/wiki/IoEJwkpp2iEdiikPvlHcYXv6n4g"}';
    expect(toolSummary(en, 'Skill', arg)).toBe('lark-doc · https://example.com/wiki/IoEJwkpp2iEdiikPvlHcYXv6n4g');
    expect(toolSummary(zh, 'Skill', arg)).toBe('lark-doc · https://example.com/wiki/IoEJwkpp2iEdiikPvlHcYXv6n4g');
  });

  it('shows only the skill name when no args are given', () => {
    expect(toolSummary(en, 'Skill', '{"skill":"lark-doc"}')).toBe('lark-doc');
  });

  it('shows the full untruncated args on separate lines in expanded mode', () => {
    const longArgs = 'x'.repeat(120);
    const arg = `{"skill":"lark-doc","args":"${longArgs}"}`;
    expect(toolSummary(en, 'Skill', arg, true)).toBe(`lark-doc\n${longArgs}`);
    expect(toolSummary(en, 'Skill', arg)).toHaveLength(80);
    expect(toolSummary(en, 'Skill', arg).endsWith('…')).toBe(true);
  });

  it('falls back to raw JSON when the skill name is missing', () => {
    const arg = '{"args":"123"}';
    expect(toolSummary(en, 'Skill', arg)).toBe(arg);
  });
});

describe('toolSummary computer use tools', () => {
  const PREFIXES = ['kimi-cu', 'plugin-kimi-cu_mac', 'plugin-kimi-cu-win_win'];
  const summary = (translate: Translator, tool: string, args: object) =>
    toolSummary(translate, `mcp__kimi-cu__${tool}`, JSON.stringify(args));

  it.each<[string, object, string, string]>([
    ['list_windows', { app: 'com.anysphere.sand' }, 'com.anysphere.sand', 'com.anysphere.sand'],
    ['activate_window', { pid: 67483, window_id: 120281 }, '', ''],
    ['get_window_state', { pid: 67483, window_id: 120281, include_screenshot: true }, '', ''],
    ['open_thing', { url: 'https://a.example', query: 'kimi', nested: { a: 1 }, flag: true, n: 1 }, 'https://a.example · kimi', 'https://a.example · kimi'],
    ['open_thing', { blob: '{"a":1}', query: '{"a":1}' }, '', ''],
    ['get_app_state', { mode: 'image', app: 'com.google.Chrome' }, 'com.google.Chrome', 'com.google.Chrome'],
    ['get_app_state', { app: 'Google Chrome', ax_filter: 'interactive' }, 'Google Chrome · interactive', 'Google Chrome · interactive'],
    ['get_app_state', { pid: 42 }, '', ''],
    ['click', { app: 'Notes', x: 10.6, y: 20.2, index: 3 }, 'Notes', 'Notes'],
    ['click', { pid: 42, x: 1, y: 2, button: 'right', count: 2 }, 'right · ×2', '右键 · ×2'],
    ['click', { app: 'Notes', index: 1, mouse_button: 'middle', count: 1 }, 'Notes · middle', 'Notes · 中键'],
    ['press_key', { app: 'Notes', keys: 'cmd+s' }, 'Notes · cmd+s', 'Notes · cmd+s'],
    ['type_text', { app: 'Notes', text: 'one\n  two' }, 'Notes · one two', 'Notes · one two'],
    ['type_text', { pid: 42, text: 'hi', submit: true }, 'hi', 'hi'],
    ['list_apps', { unexpected: 1 }, '', ''],
    ['set_value', { app: 'Notes', index: 2, value: 'on' }, 'Notes · on', 'Notes · on'],
    ['scroll', { app: 'Notes', page: 2, x: 1, y: 2 }, 'Notes · up 2 pages', 'Notes · 向上 2 页'],
    ['scroll', { app: 'Notes', page: -3 }, 'Notes · down 3 pages', 'Notes · 向下 3 页'],
    ['scroll', { app: 'Notes', dx: 5, dy: -10 }, 'Notes', 'Notes'],
    ['perform_secondary_action', { app: 'Notes', index: 4, action: 'AXPress' }, 'Notes · AXPress', 'Notes · AXPress'],
    ['drag', { app: 'Notes', from_x: 1.4, from_y: 2.5, to_x: 3, to_y: 4 }, 'Notes', 'Notes'],
    ['select_text', { index: 5, app: 'Notes', text: 'hello' }, 'Notes · hello', 'Notes · hello'],
    ['select_text', { index: 5, pid: 42, start: 2, length: 3 }, '', ''],
    ['paste', { app: 'Notes', text: 'ignored' }, 'Notes', 'Notes'],
    ['drag_paths', { app: 'Notes', window_id: 7, paths: [{}, {}] }, 'Notes · 2 paths', 'Notes · 2 条路径'],
    ['js', { code: '\n  const a = 1;\nreturn a;', timeout_ms: 10 }, 'const a = 1;', 'const a = 1;'],
    ['js_reset', { reason: 'x' }, '', ''],
    ['js_add_node_module_dir', { path: '/tmp/x' }, '', ''],
  ])('summarizes %s %j', (tool, args, enText, zhText) => {
    expect(summary(en, tool, args)).toBe(enText);
    expect(summary(zh, tool, args)).toBe(zhText);
  });

  it('prefers app over pid and clips long text to one line', () => {
    expect(summary(en, 'paste', { app: 'Notes', pid: 42 })).toBe('Notes');
    const clipped = summary(en, 'type_text', { app: 'Notes', text: `a\n${'b'.repeat(200)}` });
    expect(clipped).toHaveLength(80);
    expect(clipped.startsWith('Notes · a b')).toBe(true);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('applies under every prefix and hides JSON on the collapsed row', () => {
    for (const prefix of PREFIXES) {
      const name = `mcp__${prefix}__click`;
      expect(toolSummary(en, name, '{"app":"Notes","index":1}')).toBe('Notes');
      expect(toolSummary(en, name, '{"app":"Not')).toBe('');
      expect(toolSummary(en, `mcp__${prefix}__list_apps`, '{}')).toBe('');
    }
  });

  it('leaves no raw args for the expanded row', () => {
    const arg = '{"mode":"image","app":"com.google.Chrome","window_id":7}';
    for (const prefix of PREFIXES) {
      expect(toolSummary(en, `mcp__${prefix}__get_app_state`, arg, true)).toBe('');
    }
  });

  it('hides raw args for unknown tools and leaves other MCP servers alone', () => {
    const arg = '{"app":"com.google.Chrome","x":1}';
    expect(toolSummary(en, 'mcp__kimi-cu__wait_for_window', arg)).toBe('com.google.Chrome');
    expect(toolSummary(en, 'mcp__kimi-cu__wait_for_window', arg, true)).toBe('');
    expect(toolSummary(en, 'mcp__kimi-cu__wait_for_window', '{"pid":1,"inc')).toBe('');
    expect(toolSummary(en, 'mcp__kimi-cu__wait_for_window', '"quoted"')).toBe('');
    expect(toolSummary(en, 'mcp__other__click', arg)).toBe(arg);
  });
});
