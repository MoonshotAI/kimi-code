// apps/kimi-web/src/lib/toolMeta.ts
// Helpers for tool display. The localized text builders (toolLabel /
// toolSummary / toolChip) live in @moonshot-ai/app-core/lib (toolText) with
// the translator injected; this shell binds them to the app i18n instance so
// existing `lib/toolMeta` call sites keep working unchanged. The icon mapping
// (toolIconName / toolGlyph) stays here — it depends on the app icon registry
// (lib/icons.ts, P5).

import {
  normalizeToolName,
  toolChip as toolChipBase,
  toolLabel as toolLabelBase,
  toolSummary as toolSummaryBase,
  type ToolChipInput,
} from '@moonshot-ai/app-core/lib';
import type { Translator } from '@moonshot-ai/app-core/contracts';
import { i18n } from '../i18n';
import { iconSvg, type IconName } from './icons';

const t: Translator = (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params));

export { normalizeToolName };
export type { ToolChipInput };

export function toolLabel(name: string): string {
  return toolLabelBase(t, name);
}

export function toolSummary(name: string, arg: string, full = false): string {
  return toolSummaryBase(t, name, arg, full);
}

export function toolChip(tool: ToolChipInput): string {
  return toolChipBase(t, tool);
}

// ---------------------------------------------------------------------------
// toolGlyph: a small inline SVG string for a tool name, rendered from the
// shared icon registry (lib/icons.ts) at sm (14px). Returns '' for unknown
// tools (no glyph). Suitable for v-html in a 14×14 container.
// ---------------------------------------------------------------------------

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
  // Cron scheduling tools share a calendar motif: schedule / list / cancel.
  croncreate: 'calendar-schedule',
  cronlist: 'calendar-todo',
  crondelete: 'calendar-close',
};

export function toolIconName(name: string): IconName {
  const key = normalizeToolName(name);
  let icon = TOOL_GLYPH[key];
  if (!icon && (name ?? '').trim().toLowerCase().includes('skill')) icon = 'bolt';
  if (!icon) icon = 'tool';
  return icon;
}

export function toolGlyph(name: string): string {
  return iconSvg(toolIconName(name), 'sm');
}
