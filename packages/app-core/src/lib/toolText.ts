// packages/app-core/src/lib/toolText.ts
// Localized text builders for tool display: label / summary / chip. The
// translator is injected (first parameter) so the package never imports a
// concrete i18n instance; consumers usually pass their vue-i18n global `t`.
// Icon mapping (toolIconName / toolGlyph) stays in the consumer's toolMeta —
// it depends on the icon registry, which is a later migration phase.

import type { Translator } from '../contracts';
import { normalizeToolName } from './normalizeToolName';

// ---------------------------------------------------------------------------
// toolLabel: human-readable, localized label for a tool name
// ---------------------------------------------------------------------------

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
};

export function toolLabel(t: Translator, name: string): string {
  const key = TOOL_LABEL_KEYS[normalizeToolName(name)];
  return key ? t(key) : name;
}

// ---------------------------------------------------------------------------
// toolChip: short stat string derived from tool output / arguments
// Defensive: never throws.
// ---------------------------------------------------------------------------

export interface ToolChipInput {
  name: string;
  arg: string;
  output?: string[];
  timing?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// toolSummary: a concise, per-tool-kind header string derived from the tool's
// arguments (`arg` holds the JSON-stringified tool input, or a plain string).
// Read → path + line range, Write/Edit → path, Bash → command (CSS-truncated),
// Grep/Search → pattern, Glob/LS → path/pattern, Fetch → host/url.
// Falls back to the raw arg for unknown tools. Defensive: never throws.
// ---------------------------------------------------------------------------

const SUMMARY_MAX = 80;

function clip(s: string, max = SUMMARY_MAX): string {
  const trimmed = s.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

/** True when the tool argument carries nothing worth showing — an empty object
    `{}`, empty array `[]`, empty/`null` string, or a parsed record with no keys.
    Used to drop the noisy `{}` from the collapsed header (the expanded body
    still renders it). */
function isEmptyArg(arg: string, d: Record<string, unknown> | null): boolean {
  const s = arg.trim();
  if (s === '' || s === '{}' || s === '[]' || s === 'null') return true;
  if (d && Object.keys(d).length === 0) return true;
  return false;
}

/** Parse the JSON-stringified `arg` into a record, or null for plain strings. */
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

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Reduce a URL to "host[/first-segment]" for a compact fetch summary. */
function urlHost(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg ? `${u.host}/${seg}` : u.host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

/** Take a tool input's file path, regardless of which key the tool used. */
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

/**
 * @param full when true, skip the `…` length clip and return the complete
 *   summary — used by the expanded tool-card body (it has room to wrap). The
 *   collapsed header passes the default (clipped) form.
 */
export function toolSummary(t: Translator, name: string, arg: string, full = false): string {
  // Local clip that becomes a no-op (trim only) in `full` mode.
  const c = (s: string, max = SUMMARY_MAX): string => (full ? s.trim() : clip(s, max));
  try {
    const d = parseArg(arg);
    // Empty argument (e.g. `{}`): keep it OUT of the collapsed header title, but
    // still show it in the expanded body (full mode) so the detail isn't lost.
    if (!full && isEmptyArg(arg, d)) return '';
    // Plain-string arg (already a human string).
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
        // Keep the complete command in the DOM and let the row's available
        // width decide where the visual ellipsis belongs. A fixed character
        // clip truncates too early on wide conversation panes.
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
      default:
        return fallback();
    }
  } catch {
    return arg;
  }
}

export function toolChip(t: Translator, tool: ToolChipInput): string {
  try {
    switch (normalizeToolName(tool.name)) {
      case 'bash': {
        // Prefer timing if present
        if (tool.timing) return tool.timing;
        return '';
      }
      case 'read': {
        // Count output lines
        if (tool.output && tool.output.length > 0) {
          const count = tool.output.length;
          return t('tools.chip.lines', { count });
        }
        return '';
      }
      case 'edit':
      case 'multi_edit':
      case 'write': {
        // Try to parse +A −B from output (unified diff summary)
        if (tool.output) {
          for (const line of tool.output) {
            const m = line.match(/\+(\d+).*[-−](\d+)/);
            if (m) return `+${m[1]} −${m[2]}`;
          }
          // Also check for simple "N lines" style
          const summary = tool.output.find(l => /\d+/.test(l));
          if (summary) {
            const addMatch = summary.match(/\+(\d+)/);
            const remMatch = summary.match(/[-−](\d+)/);
            if (addMatch || remMatch) {
              return `${addMatch ? `+${addMatch[1]}` : ''} ${remMatch ? `−${remMatch[1]}` : ''}`.trim();
            }
          }
          // Succeeded but no diff counts available → just signal "edited".
          if (tool.status !== 'error') return t('tools.chip.edited');
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
