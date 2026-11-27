
import {
  computerUseArgFields as computerUseArgFieldsBase,
  computerUseToolName,
  normalizeToolName,
  toolChip as toolChipBase,
  toolLabel as toolLabelBase,
  toolSummary as toolSummaryBase,
  type ToolArgField,
  type ToolChipInput,
} from '@moonshot-ai/app-core/lib';
import { t } from '@moonshot-ai/app-client/client';
import { iconSvg, type IconName } from '@moonshot-ai/app-ui/icons';

export { normalizeToolName };
export type { ToolArgField, ToolChipInput };

export function toolLabel(name: string, arg?: string): string {
  return toolLabelBase(t, name, arg);
}

export function toolSummary(name: string, arg: string, full = false): string {
  return toolSummaryBase(t, name, arg, full);
}

export function computerUseArgFields(name: string, arg: string): ToolArgField[] {
  return computerUseArgFieldsBase(t, name, arg);
}

export function toolChip(tool: ToolChipInput): string {
  return toolChipBase(t, tool);
}

const TOOL_GLYPH: Record<string, IconName> = {
  read: 'file-text',
  bash: 'terminal',
  edit: 'pencil',
  multi_edit: 'pencil',
  write: 'file-plus',
  grep: 'search',
  search: 'search',
  glob: 'glob',
  ls: 'folder',
  web_fetch: 'globe',
  todo: 'check-list',
  task: 'sparkles',
  agentswarm: 'sparkles',
  askuserquestion: 'help-circle',
  exitplanmode: 'file-text',
  creategoal: 'target',
  getgoal: 'target',
  setgoalbudget: 'target',
  updategoal: 'target',
  waitfor: 'clock',
  tasklist: 'list',
  taskoutput: 'file-text',
  taskstop: 'stop',
  croncreate: 'calendar-schedule',
  cronlist: 'calendar-todo',
  crondelete: 'calendar-close',
  notifyuser: 'bell',
  skill: 'bolt',
};

export function toolIconName(name: string): IconName {
  if (computerUseToolName(name)) return 'device-desktop';
  const key = normalizeToolName(name);
  let icon = TOOL_GLYPH[key];
  if (!icon && (name ?? '').trim().toLowerCase().includes('skill')) icon = 'bolt';
  if (!icon) icon = 'tool';
  return icon;
}

export function toolGlyph(name: string): string {
  return iconSvg(toolIconName(name), 'sm');
}
