
import { OBJ, parse as parsePartialJson } from 'partial-json';
import type { Translator } from '../contracts';
import { computerUseToolName } from './computerUseToolName';
import { humanizeCronSchedule } from './cronSchedule';
import { isAbsoluteLocalPath } from './isAbsoluteLocalPath';
import { normalizeToolName } from './normalizeToolName';
import { basename } from './pathBasename';

const TOOL_LABEL_KEYS: Record<string, string> = {
  read: 'tools.label.read',
  bash: 'tools.label.bash',
  edit: 'tools.label.edit',
  multi_edit: 'tools.label.edit',
  write: 'tools.label.write',
  grep: 'tools.label.grep',
  glob: 'tools.label.glob',
  ls: 'tools.label.ls',
  web_fetch: 'tools.label.web_fetch',
  search: 'tools.label.search',
  todo: 'tools.label.todo',
  task: 'tools.label.task',
  agentswarm: 'tools.label.swarm',
  askuserquestion: 'tools.label.ask_user',
  exitplanmode: 'tools.label.plan',
  creategoal: 'tools.label.goal_create',
  getgoal: 'tools.label.goal_get',
  setgoalbudget: 'tools.label.goal_budget',
  updategoal: 'tools.label.goal_update',
  waitfor: 'tools.label.waitfor',
  tasklist: 'tools.label.task_list',
  taskoutput: 'tools.label.task_output',
  taskstop: 'tools.label.task_stop',
  croncreate: 'tools.label.cron_create',
  cronlist: 'tools.label.cron_list',
  crondelete: 'tools.label.cron_delete',
  notifyuser: 'tools.label.notify_user',
  skill: 'tools.label.skill',
};

const COMPUTER_USE_LABEL_KEYS = new Map<string, string>([
  ['get_app_state', 'tools.label.computerUse.inspectApp'],
  ['click', 'tools.label.computerUse.click'],
  ['press_key', 'tools.label.computerUse.pressKey'],
  ['type_text', 'tools.label.computerUse.typeText'],
  ['list_apps', 'tools.label.computerUse.listApps'],
  ['set_value', 'tools.label.computerUse.setValue'],
  ['scroll', 'tools.label.computerUse.scroll'],
  ['perform_secondary_action', 'tools.label.computerUse.elementAction'],
  ['drag', 'tools.label.computerUse.drag'],
  ['select_text', 'tools.label.computerUse.selectText'],
  ['paste', 'tools.label.computerUse.paste'],
  ['drag_paths', 'tools.label.computerUse.dragPaths'],
  ['js', 'tools.label.computerUse.js'],
  ['js_reset', 'tools.label.computerUse.jsReset'],
  ['js_add_node_module_dir', 'tools.label.computerUse.jsAddNodeModuleDir'],
  ['list_windows', 'tools.label.computerUse.listWindows'],
  ['activate_window', 'tools.label.computerUse.activateWindow'],
  ['get_window', 'tools.label.computerUse.getWindow'],
  ['get_window_state', 'tools.label.computerUse.getWindowState'],
  ['launch_app', 'tools.label.computerUse.launchApp'],
  ['debug_tap', 'tools.label.computerUse.debugTap'],
]);

function computerUseLabel(t: Translator, tool: string, arg?: string): string {
  const key = COMPUTER_USE_LABEL_KEYS.get(tool);
  if (!key) {
    const words = tool.replace(/_+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  if (tool === 'get_app_state' && arg !== undefined) {
    const mode = parseArg(arg)?.mode;
    if (mode === 'image') return t('tools.label.computerUse.screenshotApp');
    if (mode === 'ax') return t('tools.label.computerUse.readApp');
  }
  return t(key);
}

export function toolLabel(t: Translator, name: string, arg?: string): string {
  const computerUseTool = computerUseToolName(name);
  if (computerUseTool) return computerUseLabel(t, computerUseTool, arg);
  const normalized = normalizeToolName(name);
  if (normalized === 'croncreate' && arg !== undefined && parseArg(arg)?.recurring === false) {
    return t('tools.label.cron_create_once');
  }
  const key = TOOL_LABEL_KEYS[normalized];
  return key ? t(key) : name;
}

export interface ToolChipInput {
  name: string;
  arg: string;
  output?: string[];
  timing?: string;
  status?: string;
}

const SUMMARY_MAX = 80;

function clip(s: string, max = SUMMARY_MAX): string {
  const trimmed = s.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

function isEmptyArg(arg: string, d: Record<string, unknown> | null): boolean {
  const s = arg.trim();
  if (s === '' || s === '{}' || s === '[]' || s === 'null') return true;
  if (d && Object.keys(d).length === 0) return true;
  return false;
}

function parseArg(arg: string): Record<string, unknown> | null {
  const s = arg.trim();
  if (!s.startsWith('{')) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parsePartialArg(arg: string): Record<string, unknown> | null {
  const complete = parseArg(arg);
  if (complete) return complete;
  const s = arg.trim();
  if (!s.startsWith('{')) return null;
  try {
    const v: unknown = parsePartialJson(s, OBJ);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const record = v as Record<string, unknown>;
    return Object.keys(record).length > 0 ? record : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function urlHost(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg ? `${u.host}/${seg}` : u.host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

function filePath(d: Record<string, unknown>): string | undefined {
  return str(d.path) ?? str(d.file_path) ?? str(d.filePath) ?? str(d.filename);
}

const GOAL_STATUS_KEYS: Record<string, string> = {
  active: 'status.goalStatusActive',
  blocked: 'status.goalStatusBlocked',
  complete: 'status.goalStatusComplete',
};

function goalStatusLabel(t: Translator, value: unknown): string | undefined {
  const status = str(value);
  if (!status) return undefined;
  const key = GOAL_STATUS_KEYS[status];
  return key ? t(key) : status;
}

function goalBudgetSummary(t: Translator, d: Record<string, unknown>): string | undefined {
  const value = num(d.value);
  const unit = str(d.unit);
  if (value === undefined || !unit) return undefined;
  switch (unit) {
    case 'turns':
      return t('tools.goal.turns', { value });
    case 'tokens':
      return t('tools.goal.tokens', { value });
    case 'milliseconds':
      return t('tools.goal.milliseconds', { value });
    case 'seconds':
      return t('tools.goal.seconds', { value });
    case 'minutes':
      return t('tools.goal.minutes', { value });
    case 'hours':
      return t('tools.goal.hours', { value });
    default:
      return t('tools.goal.budget', { value, unit });
  }
}

const COMPUTER_USE_SILENT_TOOLS = new Set(['list_apps', 'js_reset', 'js_add_node_module_dir']);
const COMPUTER_USE_VALUE_ARGS = ['ax_filter', 'keys', 'key', 'text', 'value', 'action', 'url', 'query', 'title', 'name', 'path'];

function oneLine(v: unknown): string | undefined {
  return str(v)?.replace(/\s+/g, ' ').trim();
}

function computerUseText(v: unknown): string | undefined {
  const text = oneLine(v);
  return text && !/^[{[]/.test(text) ? text : undefined;
}

function computerUseButton(t: Translator, d: Record<string, unknown>): string | undefined {
  const button = str(d.button) ?? str(d.mouse_button);
  if (button === 'right') return t('tools.summary.computerUse.rightButton');
  if (button === 'middle') return t('tools.summary.computerUse.middleButton');
  return undefined;
}

function computerUseScroll(t: Translator, d: Record<string, unknown>): string | undefined {
  const page = Math.round(num(d.page) ?? 0);
  if (page === 0) return undefined;
  const key = page > 0 ? 'scrollUp' : 'scrollDown';
  return t(`tools.summary.computerUse.${key}`, { count: Math.abs(page) });
}

function computerUseDetails(t: Translator, tool: string, d: Record<string, unknown>): unknown[] {
  switch (tool) {
    case 'click': {
      const count = num(d.count);
      return [computerUseButton(t, d), count !== undefined && count > 1 ? `×${Math.round(count)}` : undefined];
    }
    case 'scroll':
      return [computerUseScroll(t, d)];
    case 'drag_paths':
      return [
        Array.isArray(d.paths) && d.paths.length > 0
          ? t('tools.summary.computerUse.paths', { count: d.paths.length })
          : undefined,
      ];
    default:
      return [];
  }
}

function computerUseSummary(t: Translator, tool: string, d: Record<string, unknown>): string {
  if (COMPUTER_USE_SILENT_TOOLS.has(tool)) return '';
  if (tool === 'js') return computerUseText(str(d.code)?.split('\n').find((line) => line.trim())) ?? '';
  const values = tool === 'paste' ? [] : COMPUTER_USE_VALUE_ARGS.map((key) => computerUseText(d[key]));
  return [computerUseText(d.app), ...values, ...computerUseDetails(t, tool, d)].filter(Boolean).join(' · ');
}

function computerUseToolSummary(t: Translator, tool: string, arg: string, full: boolean): string {
  const d = parseArg(arg);
  if (d) return full ? '' : clip(computerUseSummary(t, tool, d));
  const text = arg.replace(/^·\s*/, '').trim();
  if (text === 'null' || /^[{["]/.test(text)) return '';
  return full ? text : clip(text);
}

const COMPUTER_USE_FIELD_KEYS = new Map<string, string>([
  ['app', 'app'],
  ['pid', 'pid'],
  ['window_id', 'windowId'],
  ['include_screenshot', 'includeScreenshot'],
  ['screenshot_id', 'screenshotId'],
  ['mode', 'mode'],
  ['screenshot_detail', 'screenshotDetail'],
  ['ax_filter', 'axFilter'],
  ['index', 'index'],
  ['x', 'x'],
  ['y', 'y'],
  ['from_x', 'fromX'],
  ['from_y', 'fromY'],
  ['to_x', 'toX'],
  ['to_y', 'toY'],
  ['button', 'button'],
  ['mouse_button', 'mouseButton'],
  ['channel', 'channel'],
  ['count', 'count'],
  ['hold_ms', 'holdMs'],
  ['steps', 'steps'],
  ['keys', 'keys'],
  ['activate', 'activate'],
  ['text', 'text'],
  ['clear', 'clear'],
  ['submit', 'submit'],
  ['format', 'format'],
  ['value', 'value'],
  ['action', 'action'],
  ['page', 'page'],
  ['dx', 'dx'],
  ['dy', 'dy'],
  ['start', 'start'],
  ['length', 'length'],
  ['prefix', 'prefix'],
  ['suffix', 'suffix'],
  ['selection', 'selection'],
  ['paths', 'paths'],
  ['abort_if_cursor_in_window', 'abortIfCursorInWindow'],
  ['code', 'code'],
  ['timeout_ms', 'timeoutMs'],
  ['additional_window_ids', 'additionalWindowIds'],
  ['include_text', 'includeText'],
  ['running_only', 'runningOnly'],
  ['snapshot_id', 'snapshotId'],
  ['rect', 'rect'],
  ['disable_diff', 'disableDiff'],
  ['limit', 'limit'],
  ['offset', 'offset'],
  ['allow_foreground_fallback', 'allowForegroundFallback'],
  ['hover_ms', 'hoverMs'],
  ['verify_after', 'verifyAfter'],
  ['step_ms', 'stepMs'],
  ['autosubmit', 'autosubmit'],
  ['path', 'path'],
  ['seconds', 'seconds'],
]);

const COMPUTER_USE_VALUE_KEYS: Record<string, Record<string, string>> = {
  mode: { full: 'modeFull', image: 'modeImage', ax: 'modeAx' },
  button: { left: 'buttonLeft', right: 'buttonRight', middle: 'buttonMiddle' },
  mouse_button: { left: 'buttonLeft', right: 'buttonRight', middle: 'buttonMiddle' },
  screenshot_detail: { standard: 'detailStandard', high: 'detailHigh' },
  selection: { text: 'selectionText', cursor_before: 'selectionCursorBefore', cursor_after: 'selectionCursorAfter' },
};

export interface ToolArgField {
  key: string;
  label: string;
  value: string;
}

function computerUseFieldValue(t: Translator, key: string, value: unknown): string {
  if (typeof value === 'boolean') return t(`tools.field.computerUseValue.${value ? 'yes' : 'no'}`);
  if (typeof value === 'string') {
    const valueKey = COMPUTER_USE_VALUE_KEYS[key]?.[value];
    return valueKey ? t(`tools.field.computerUseValue.${valueKey}`) : value;
  }
  if (key === 'page' && typeof value === 'number' && value !== 0) {
    const direction = value > 0 ? 'scrollUp' : 'scrollDown';
    return t(`tools.summary.computerUse.${direction}`, { count: Math.abs(value) });
  }
  if (key === 'index' && typeof value === 'number') return `#${value}`;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join('\n');
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

export function computerUseArgFields(t: Translator, name: string, arg: string): ToolArgField[] {
  if (!computerUseToolName(name)) return [];
  const d = parseArg(arg);
  if (!d) return [];
  const present = Object.entries(d).filter(([, value]) => value !== null && value !== undefined && value !== '');
  const known = [...COMPUTER_USE_FIELD_KEYS.keys()].filter((key) => present.some(([k]) => k === key));
  const unknown = present.map(([key]) => key).filter((key) => !COMPUTER_USE_FIELD_KEYS.has(key));
  return [...known, ...unknown].map((key) => {
    const labelKey = COMPUTER_USE_FIELD_KEYS.get(key);
    return {
      key,
      label: labelKey ? t(`tools.field.computerUse.${labelKey}`) : key,
      value: computerUseFieldValue(t, key, d[key]),
    };
  });
}

export function toolSummary(t: Translator, name: string, arg: string, full = false): string {
  const computerUseTool = computerUseToolName(name);
  if (computerUseTool) return computerUseToolSummary(t, computerUseTool, arg, full);
  const c = (s: string, max = SUMMARY_MAX): string => (full ? s.trim() : clip(s, max));
  try {
    const d = parseArg(arg);
    if (!full && isEmptyArg(arg, d)) return '';
    const fallback = () => c(arg.replace(/^·\s*/, ''));
    if (!d) return fallback();

    switch (normalizeToolName(name)) {
      case 'read': {
        const path = filePath(d);
        if (!path) return fallback();
        const start = num(d.offset) ?? num(d.line_start) ?? num(d.start_line);
        const len = num(d.limit) ?? num(d.length);
        const end = num(d.line_end) ?? num(d.end_line) ?? (start !== undefined && len !== undefined ? start + len : undefined);
        if (start !== undefined && end !== undefined) return c(`${path}:${start}-${end}`);
        if (start !== undefined) return c(`${path}:${start}`);
        return c(path);
      }
      case 'write': {
        const path = filePath(d);
        return path ? c(`${path}  ${t('tools.chip.created')}`) : fallback();
      }
      case 'edit':
      case 'multi_edit': {
        const path = filePath(d);
        return path ? c(path) : fallback();
      }
      case 'bash': {
        const cmd = str(d.command) ?? str(d.cmd) ?? str(d.script);
        return cmd ? cmd.trim() : fallback();
      }
      case 'grep':
      case 'search': {
        const pattern = str(d.pattern) ?? str(d.query) ?? str(d.regex);
        const path = str(d.path) ?? str(d.glob) ?? str(d.include);
        if (pattern && path) return c(t('tools.summary.inScope', { value: pattern, scope: path }));
        return pattern ? c(pattern) : fallback();
      }
      case 'glob': {
        const pattern = str(d.pattern) ?? str(d.glob) ?? str(d.query);
        const path = str(d.path) ?? str(d.cwd);
        if (pattern && path) return c(t('tools.summary.inScope', { value: pattern, scope: path }));
        return pattern ? c(pattern) : (str(d.path) ? c(str(d.path)!) : fallback());
      }
      case 'ls': {
        const dir = str(d.path) ?? str(d.dir) ?? str(d.directory) ?? str(d.cwd);
        return dir ? c(dir) : fallback();
      }
      case 'web_fetch': {
        const url = str(d.url) ?? str(d.uri);
        return url ? c(urlHost(url)) : fallback();
      }
      case 'todo':
      case 'task': {
        const label =
          str(d.description) ?? str(d.title) ?? str(d.prompt) ?? str(d.name) ?? str(d.subagent_type);
        if (label) return c(label);
        const items = Array.isArray(d.todos) ? d.todos : Array.isArray(d.items) ? d.items : undefined;
        if (items) return c(t('tools.chip.todos', { count: items.length }));
        return fallback();
      }
      case 'creategoal': {
        if (full) return fallback();
        const objective = str(d.objective);
        const criterion = str(d.completionCriterion);
        if (objective && criterion) return c(t('tools.goal.objectiveWithCriterion', { objective, criterion }));
        return objective ? c(objective) : fallback();
      }
      case 'getgoal': {
        if (full) return fallback();
        return '';
      }
      case 'setgoalbudget': {
        if (full) return fallback();
        const summary = goalBudgetSummary(t, d);
        return summary ? c(summary) : fallback();
      }
      case 'updategoal': {
        if (full) return fallback();
        const status = goalStatusLabel(t, d.status);
        return status ? c(t('tools.goal.status', { status })) : fallback();
      }
      case 'croncreate': {
        if (full) return fallback();
        const cron = str(d.cron);
        if (!cron) return fallback();
        const human = humanizeCronSchedule(t, cron, d.recurring !== false);
        return human ? c(human) : '';
      }
      case 'crondelete': {
        if (full) return fallback();
        return '';
      }
      case 'skill': {
        const skill = str(d.skill) ?? str(d.name);
        if (!skill) return fallback();
        const args = str(d.args);
        if (full) return args ? `${skill}\n${args}` : skill;
        return args ? c(`${skill} · ${args}`) : c(skill);
      }
      default:
        return fallback();
    }
  } catch {
    return arg;
  }
}

const ACTIVITY_FILE_KINDS = new Set(['read', 'write', 'edit', 'multi_edit']);

export function activityToolSummary(t: Translator, name: string, arg: string, full = false): string {
  const parsed = parseArg(arg);
  const d = parsed ?? parsePartialArg(arg);
  const summaryArg = parsed || !d ? arg : JSON.stringify(d);
  if (d && ACTIVITY_FILE_KINDS.has(normalizeToolName(name))) {
    const path = filePath(d);
    if (path) {
      const fullSummary = toolSummary(t, name, summaryArg, true);
      if (full) return fullSummary;
      const shortPath = isAbsoluteLocalPath(path) ? basename(path) : path;
      const index = fullSummary.indexOf(path);
      if (index >= 0) return clip(`${fullSummary.slice(0, index)}${shortPath}${fullSummary.slice(index + path.length)}`);
    }
  }
  const summary = toolSummary(t, name, summaryArg, full);
  const fallback = full ? summaryArg.trim() : clip(summaryArg.replace(/^·\s*/, ''));
  return summary === fallback && /^[{["]/.test(summary.trimStart()) ? '' : summary;
}

export function toolChip(t: Translator, tool: ToolChipInput): string {
  try {
    switch (normalizeToolName(tool.name)) {
      case 'bash': {
        if (tool.timing) return tool.timing;
        return '';
      }
      case 'read': {
        if (tool.output && tool.output.length > 0) {
          const count = tool.output.length;
          return t('tools.chip.lines', { count });
        }
        return '';
      }
      case 'edit':
      case 'multi_edit':
      case 'write': {
        if (tool.output) {
          for (const line of tool.output) {
            const added = /\+(\d+)/.exec(line);
            if (added) {
              let removed: RegExpExecArray | null = null;
              for (const match of line.slice(added.index + added[0].length).matchAll(/[-−](\d+)/g)) removed = match;
              if (removed) return `+${added[1]} −${removed[1]}`;
            }
          }
          const summary = tool.output.find(l => /\d+/.test(l));
          if (summary) {
            const addMatch = summary.match(/\+(\d+)/);
            const remMatch = summary.match(/[-−](\d+)/);
            if (addMatch || remMatch) {
              return `${addMatch ? `+${addMatch[1]}` : ''} ${remMatch ? `−${remMatch[1]}` : ''}`.trim();
            }
          }
          if (tool.status === 'ok') return t('tools.chip.edited');
        }
        return '';
      }
      case 'grep':
      case 'search': {
        if (tool.output && tool.output.length > 0) {
          return t('tools.chip.results', { count: tool.output.length });
        }
        return '';
      }
      default:
        return '';
    }
  } catch {
    return '';
  }
}
