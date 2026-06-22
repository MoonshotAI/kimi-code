// apps/kimi-web/src/lib/toolMeta.ts
// Helpers for tool display. Labels/chips are localized via the shared i18n instance.

import { i18n } from '../i18n';

const t = i18n.global.t;

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
};

// ---------------------------------------------------------------------------
// normalizeToolName: fold the many real-world spellings of a tool name into the
// canonical lowercase kind used by the maps below. Daemon tool names arrive
// verbatim and may be CamelCase (`Read`, `MultiEdit`, `WebFetch`, `TodoWrite`)
// or aliased (`shell`, `fetch`). Without this, those names silently fall through
// to the default glyph / raw-arg summary.
// ---------------------------------------------------------------------------

const NAME_ALIASES: Record<string, string> = {
  multiedit: 'multi_edit',
  multiedits: 'multi_edit',
  shell: 'bash',
  run: 'bash',
  exec: 'bash',
  ripgrep: 'grep',
  rg: 'grep',
  find: 'glob',
  fetch: 'web_fetch',
  webfetch: 'web_fetch',
  url_fetch: 'web_fetch',
  urlfetch: 'web_fetch',
  list: 'ls',
  listdir: 'ls',
  list_dir: 'ls',
  todowrite: 'todo',
  todo_write: 'todo',
  todoread: 'todo',
  todolist: 'todo',
  todo_list: 'todo',
  agent: 'task',
  subagent: 'task',
  websearch: 'search',
  web_search: 'search',
};

export function normalizeToolName(name: string): string {
  const lower = (name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return NAME_ALIASES[lower] ?? lower;
}

export function toolLabel(name: string): string {
  const key = TOOL_LABEL_KEYS[normalizeToolName(name)];
  return key ? t(key) : name;
}

// ---------------------------------------------------------------------------
// toolGlyph: a small inline SVG string (viewBox="0 0 16 16") or short glyph
// Each returns an <svg> string suitable for v-html in a 14×14 container,
// OR a plain Unicode glyph string when SVG would be excessive.
// ---------------------------------------------------------------------------

// read → plain document with text lines.
const GLYPH_READ = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="1.5" width="9" height="13" rx="1"/><line x1="5" y1="5" x2="9" y2="5"/><line x1="5" y1="7.5" x2="11" y2="7.5"/><line x1="5" y1="10" x2="10" y2="10"/></svg>`;
// bash → terminal window with a chevron prompt.
const GLYPH_BASH = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><polyline points="4,6 6.5,8 4,10"/><line x1="8" y1="10" x2="12" y2="10"/></svg>`;
// edit → pencil.
const GLYPH_EDIT = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><path d="M10.5 2.5l3 3-8 8H2.5v-3l8-8z"/><line x1="8.5" y1="4.5" x2="11.5" y2="7.5"/></svg>`;
// write → document with a plus.
const GLYPH_WRITE = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><path d="M3 12V4.5L8 2l5 2.5V12H3z"/><line x1="6" y1="7" x2="10" y2="7"/><line x1="8" y1="5" x2="8" y2="9"/></svg>`;
// grep / search → magnifier.
const GLYPH_GREP = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><circle cx="6.5" cy="6.5" r="4"/><line x1="9.5" y1="9.5" x2="13.5" y2="13.5"/></svg>`;
// glob → asterisk between braces (filename pattern).
const GLYPH_GLOB = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><path d="M5 2.5C3.5 2.5 3.5 5 3.5 6.5S2.5 8 2.5 8s1 0 1 1.5S3.5 13.5 5 13.5"/><path d="M11 2.5c1.5 0 1.5 2.5 1.5 4S13.5 8 13.5 8s-1 0-1 1.5.5 4-1.5 4"/><line x1="8" y1="6" x2="8" y2="10"/><line x1="6.3" y1="6.8" x2="9.7" y2="9.2"/><line x1="9.7" y1="6.8" x2="6.3" y2="9.2"/></svg>`;
// ls → folder.
const GLYPH_LS = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.2 1.4H13a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5z"/></svg>`;
// web_fetch → globe.
const GLYPH_WEB = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6"/><path d="M8 2c-2 2-3 3.6-3 6s1 4 3 6"/><path d="M8 2c2 2 3 3.6 3 6s-1 4-3 6"/><line x1="2" y1="8" x2="14" y2="8"/></svg>`;
// todo / task → checklist.
const GLYPH_TODO = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><polyline points="2,4.5 3.5,6 5.5,3"/><polyline points="2,11 3.5,12.5 5.5,9.5"/><line x1="8" y1="4.5" x2="14" y2="4.5"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`;
// skill → lightning bolt.
const GLYPH_SKILL = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M8.5 1L3 9h4l-1.5 6 5.5-8h-4l1.5-6z"/></svg>`;
// default → empty (no glyph for unknown tools).
const GLYPH_DEFAULT = '';

export function toolGlyph(name: string): string {
  switch (normalizeToolName(name)) {
    case 'read':       return GLYPH_READ;
    case 'bash':       return GLYPH_BASH;
    case 'edit':       return GLYPH_EDIT;
    case 'multi_edit': return GLYPH_EDIT;
    case 'write':      return GLYPH_WRITE;
    case 'grep':       return GLYPH_GREP;
    case 'search':     return GLYPH_GREP;
    case 'glob':       return GLYPH_GLOB;
    case 'ls':         return GLYPH_LS;
    case 'web_fetch':  return GLYPH_WEB;
    case 'todo':       return GLYPH_TODO;
    case 'task':       return GLYPH_TODO;
    default: {
      const lower = (name ?? '').trim().toLowerCase();
      if (lower.includes('skill')) return GLYPH_SKILL;
      return GLYPH_DEFAULT;
    }
  }
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
// Read → path + line range, Write/Edit → path, Bash → command (truncated),
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

const BASH_MAX = 64;

/**
 * @param full when true, skip the `…` length clip and return the complete
 *   summary — used by the expanded tool-card body (it has room to wrap). The
 *   collapsed header passes the default (clipped) form.
 */
export function toolSummary(name: string, arg: string, full = false): string {
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
        return cmd ? c(cmd, BASH_MAX) : fallback();
      }
      case 'grep':
      case 'search': {
        const pattern = str(d.pattern) ?? str(d.query) ?? str(d.regex);
        const path = str(d.path) ?? str(d.glob) ?? str(d.include);
        if (pattern && path) return c(`${pattern}  in ${path}`);
        return pattern ? c(pattern) : fallback();
      }
      case 'glob': {
        const pattern = str(d.pattern) ?? str(d.glob) ?? str(d.query);
        const path = str(d.path) ?? str(d.cwd);
        if (pattern && path) return c(`${pattern}  in ${path}`);
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
      default:
        return fallback();
    }
  } catch {
    return arg;
  }
}

export function toolChip(tool: ToolChipInput): string {
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
