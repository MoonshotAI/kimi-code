import { describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { Translator } from '../src/contracts';
import { toolLabel } from '../src/lib/toolText';

const t = ((key: string) => key) as Translator;

describe('toolLabel', () => {
  it('localizes FetchURL through the web fetch alias', () => {
    expect(toolLabel(t, 'FetchURL')).toBe('tools.label.web_fetch');
  });

  it('localizes background task tools', () => {
    expect(toolLabel(t, 'TaskList')).toBe('tools.label.task_list');
    expect(toolLabel(t, 'TaskOutput')).toBe('tools.label.task_output');
    expect(toolLabel(t, 'TaskStop')).toBe('tools.label.task_stop');
    expect(toolLabel(t, 'task_output')).toBe('tools.label.task_output');
  });

  it('localizes cron tools', () => {
    expect(toolLabel(t, 'CronCreate')).toBe('tools.label.cron_create');
    expect(toolLabel(t, 'CronList')).toBe('tools.label.cron_list');
    expect(toolLabel(t, 'CronDelete')).toBe('tools.label.cron_delete');
  });

  it('varies the CronCreate label by the recurring arg', () => {
    expect(toolLabel(t, 'CronCreate', '{"cron":"0 9 * * *","recurring":false}')).toBe('tools.label.cron_create_once');
    expect(toolLabel(t, 'CronCreate', '{"cron":"0 9 * * *","recurring":true}')).toBe('tools.label.cron_create');
    expect(toolLabel(t, 'CronCreate', '{"cron":"0 9 * * *"}')).toBe('tools.label.cron_create');
  });

  it.each([
    ['CronCreate', undefined, 'Schedule Job', '创建定时任务'],
    ['CronCreate', '{"recurring":false}', 'Schedule One-Shot Job', '创建单次定时任务'],
    ['CronList', undefined, 'Cron Jobs', '定时任务列表'],
    ['CronDelete', undefined, 'Delete Cron Job', '删除定时任务'],
  ])('renders %s in en and zh', (name, arg, en, zh) => {
    const i18n = createKimiI18n({ locale: 'en' });
    const translate: Translator = (key, params) =>
      params === undefined ? i18n.global.t(key) : i18n.global.t(key, params);
    expect(toolLabel(translate, name, arg)).toBe(en);
    i18n.global.locale.value = 'zh';
    expect(toolLabel(translate, name, arg)).toBe(zh);
  });

  it('keeps unknown tool names as-is', () => {
    expect(toolLabel(t, 'CustomThing')).toBe('CustomThing');
  });
});

describe('toolLabel computer use tools', () => {
  const PREFIXES = ['kimi-cu', 'plugin-kimi-cu_mac', 'plugin-kimi-cu-win_win'];
  const locale = (name: 'en' | 'zh'): Translator => {
    const i18n = createKimiI18n({ locale: name });
    return (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params));
  };

  it.each([
    ['get_app_state', '{"mode":"image"}', 'Screenshot app', '截取应用画面'],
    ['get_app_state', '{"mode":"ax"}', 'Read app UI', '读取应用界面'],
    ['get_app_state', '{"mode":"full"}', 'Inspect app', '查看应用'],
    ['get_app_state', '{"app":"Notes"}', 'Inspect app', '查看应用'],
    ['get_app_state', undefined, 'Inspect app', '查看应用'],
    ['click', undefined, 'Click', '点击'],
    ['press_key', undefined, 'Press key', '按键'],
    ['type_text', undefined, 'Type text', '输入文本'],
    ['list_apps', undefined, 'List apps', '列出应用'],
    ['set_value', undefined, 'Set value', '设置值'],
    ['scroll', undefined, 'Scroll', '滚动'],
    ['perform_secondary_action', undefined, 'Element action', '元素操作'],
    ['drag', undefined, 'Drag', '拖动'],
    ['select_text', undefined, 'Select text', '选择文本'],
    ['paste', undefined, 'Paste', '粘贴'],
    ['drag_paths', undefined, 'Drag paths', '拖动路径'],
    ['js', undefined, 'Run script', '运行脚本'],
    ['js_reset', undefined, 'Reset script runtime', '重置脚本环境'],
    ['js_add_node_module_dir', undefined, 'Add module directory', '添加模块目录'],
  ])('renders %s (%s) under every prefix in en and zh', (tool, arg, enLabel, zhLabel) => {
    for (const prefix of PREFIXES) {
      expect(toolLabel(locale('en'), `mcp__${prefix}__${tool}`, arg)).toBe(enLabel);
      expect(toolLabel(locale('zh'), `mcp__${prefix}__${tool}`, arg)).toBe(zhLabel);
    }
  });

  it('humanizes unknown tools under the computer use prefixes', () => {
    for (const prefix of PREFIXES) {
      expect(toolLabel(t, `mcp__${prefix}__wait_for_window`)).toBe('Wait for window');
    }
  });

  it('leaves other MCP tools raw', () => {
    expect(toolLabel(t, 'mcp__other__click')).toBe('mcp__other__click');
    expect(toolLabel(t, 'mcp__kimi_cu__click')).toBe('mcp__kimi_cu__click');
    expect(toolLabel(t, 'mcp__plugin-kimi-cu_win__click')).toBe('mcp__plugin-kimi-cu_win__click');
    expect(toolLabel(t, 'mcp__kimi-cu__')).toBe('mcp__kimi-cu__');
  });
});
