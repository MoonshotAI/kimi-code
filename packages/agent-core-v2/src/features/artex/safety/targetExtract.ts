import { isIPv4, isIPv6, maskedCidr, parseCidr } from './net';
import { normalizeHost, normalizeTarget, targetName, validHostname, type ArtexTarget } from './target';

/**
 * The tools whose input names no network target: the search tool, the file and
 * session tools, and the platform's own domain tools. Every tool not listed here
 * is scanned, so a tool added later is gated by default. Ported from ARTEX
 * intercept.noTargetTools, adapted to the kimi-code tool set.
 */
export const ARTEX_NO_TARGET_TOOLS: ReadonlySet<string> = new Set([
  'WebSearch',
  'web_search',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'LS',
  'Glob',
  'Grep',
  'TodoWrite',
  'sleep',
  'TaskOutput',
  'TaskStop',
  'TaskList',
  'start_artex_exploration',
  'graph_overview',
  'list_findings',
  'list_facts',
  'node_detail',
  'expand_digest',
  'get_worker_output',
  'get_worker_trace',
  'search_all_worker_traces',
  'list_worker_traces',
  'add_hint',
  'add_intent',
  'steer_work',
  'kill_work',
  'set_goals',
  'set_constraints',
  'list_goals',
  'prove_goal',
  'goal_met',
  'insert_assets',
  'add_company_scope',
  'add_task_scope',
  'list_assets',
  'list_untested_assets',
  'list_companies',
  'report_finding',
  'record_fact',
  'save_task_credential',
  'list_task_credentials',
  'record_coverage',
  'traffic_search',
  'traffic_get',
  'traffic_blob',
  'bind_finding_traffic',
  'get_finding_traffic',
  'update_finding_report',
  'ask_operator',
  'ingest_scan_output',
  'ingest_bbot',
  'Agent',
  'AgentSwarm',
  'NotifyUser',
  'AskUserQuestion',
  'Skill',
]);

export interface ArtexDeclaredTargets {
  readonly targets: readonly ArtexTarget[];
  readonly urls: readonly string[];
}

/**
 * Reads what a tool call declares: its network targets and the URLs it writes.
 * Ported from ARTEX intercept.extractDeclared. The input is the parsed tool
 * arguments object.
 */
export function extractDeclaredTargets(toolName: string, args: unknown): ArtexDeclaredTargets {
  if (ARTEX_NO_TARGET_TOOLS.has(toolName)) return { targets: [], urls: [] };
  const list = new TargetList();
  switch (toolName) {
    case 'FetchURL':
    case 'WebFetch': {
      const url = stringField(args, 'url');
      if (url !== undefined) {
        const target = normalizeTarget(url);
        if (target !== undefined) {
          list.add(target);
          list.addUrl(url.trim());
        }
      }
      break;
    }
    case 'Bash':
    case 'shell_open':
    case 'Monitor':
      list.scan(stringField(args, 'command') ?? '');
      break;
    case 'shell_send':
      list.scan(stringField(args, 'text') ?? '');
      break;
    default:
      for (const value of collectStrings(args)) list.scan(value);
      break;
  }
  return { targets: list.targets, urls: list.urls };
}

export function extractTargets(toolName: string, args: unknown): readonly ArtexTarget[] {
  return extractDeclaredTargets(toolName, args).targets;
}

function stringField(args: unknown, field: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function collectStrings(value: unknown): readonly string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (typeof node === 'object' && node !== null) {
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(value);
  return out;
}

const SHELL_META = '|;&(){},\\';

class TargetList {
  readonly targets: ArtexTarget[] = [];
  readonly urls: string[] = [];
  private readonly seen = new Set<string>();

  add(target: ArtexTarget): void {
    const key = `${target.kind}|${target.host}|${String(target.port)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.targets.push(target);
  }

  addUrl(url: string): void {
    this.urls.push(url);
  }

  scan(source: string): void {
    if (source === '') return;
    const chars = Array.from(source);
    const blank = (from: number, to: number): void => {
      for (let i = from; i < to && i < chars.length; i += 1) chars[i] = ' ';
    };
    const current = (): string => chars.join('');

    this.scanUrls(current(), chars, blank, source);
    this.scanBracketed(current(), blank);
    this.scanIPv6(current(), chars, blank);
    this.scanIPv4(current(), chars, blank);
    this.scanHostPort(current(), chars, blank);
  }

  private scanUrls(
    text: string,
    chars: string[],
    blank: (from: number, to: number) => void,
    source: string,
  ): void {
    const re = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#"'<>`]*)[^\s"'<>`]*/gi;
    for (const match of text.matchAll(re)) {
      const start = match.index;
      const full = match[0];
      const scheme = match[1] ?? '';
      const authority = match[2] ?? '';
      const end = start + full.length;
      let found = false;
      for (const host of urlHosts(authority)) {
        const target = normalizeTarget(scheme + host);
        if (target !== undefined && (target.kind !== 'domain' || validHostname(target.host))) {
          this.add(target);
          found = true;
        }
      }
      if (found) this.urls.push(source.slice(start, end));
      blank(start, end);
    }
  }

  private scanBracketed(text: string, blank: (from: number, to: number) => void): void {
    const re = /\[([0-9A-Fa-f:.]+(?:%[\w.-]+)?)\](?::(\d{1,5}))?/g;
    for (const match of text.matchAll(re)) {
      const addr = match[1] ?? '';
      if (!isIPv6(addr) && !isIPv4(addr)) continue;
      const normalized = normalizeHost(addr, false);
      if (normalized === undefined || normalized.kind !== 'ip') continue;
      const port = match[2] !== undefined ? validPort(match[2]) : 0;
      this.add({ kind: 'ip', host: normalized.host, port });
      blank(match.index, match.index + match[0].length);
    }
  }

  private scanIPv6(text: string, chars: string[], blank: (from: number, to: number) => void): void {
    const re = /[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[\w.-]+)?(?:\/\d{1,3})?/g;
    for (const match of text.matchAll(re)) {
      const start = match.index;
      const end = start + match[0].length;
      if ((start > 0 && isWord(chars[start - 1])) || (end < chars.length && (isWord(chars[end]) || chars[end] === ':'))) {
        continue;
      }
      const normalized = normalizeHost(match[0], false);
      if (normalized === undefined || normalized.kind === 'domain' || normalized.host === '::') continue;
      this.add({ kind: normalized.kind, host: normalized.host, port: 0 });
      blank(start, end);
    }
  }

  private scanIPv4(text: string, chars: string[], blank: (from: number, to: number) => void): void {
    const re = /\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2}|:\d{1,5})?/g;
    for (const match of text.matchAll(re)) {
      const start = match.index;
      let end = start + match[0].length;
      if (start > 0 && (isWord(chars[start - 1]) || chars[start - 1] === '.')) continue;
      const sep = match[0].search(/[/:]/);
      const addrEnd = sep >= 0 ? start + sep : end;
      if (!endsToken(chars, end)) {
        end = addrEnd;
        if (!endsToken(chars, end)) continue;
      }
      const addr = chars.slice(start, addrEnd).join('');
      if (!isIPv4(addr)) continue;
      let target: ArtexTarget = { kind: 'ip', host: addr, port: 0 };
      if (end > addrEnd) {
        const separator = chars[addrEnd];
        const suffix = chars.slice(addrEnd + 1, end).join('');
        if (separator === '/') {
          const cidr = chars.slice(start, end).join('');
          if (parseCidr(cidr) !== undefined) target = { kind: 'cidr', host: maskedCidr(cidr), port: 0 };
        } else if (separator === ':') {
          target = { kind: 'ip', host: addr, port: validPort(suffix) };
        }
      }
      this.add(target);
      blank(start, end);
    }
  }

  private scanHostPort(text: string, chars: string[], blank: (from: number, to: number) => void): void {
    const re =
      /(?:localhost|[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.[a-z][a-z0-9-]*[a-z0-9]):\d{1,5}/gi;
    for (const match of text.matchAll(re)) {
      const start = match.index;
      const end = start + match[0].length;
      if (start > 0 && (isWord(chars[start - 1]) || '.-/\\'.includes(chars[start - 1] ?? ''))) continue;
      if (!endsToken(chars, end)) continue;
      const colon = match[0].indexOf(':');
      const hostRaw = match[0].slice(0, colon);
      const portRaw = match[0].slice(colon + 1);
      const port = validPort(portRaw);
      const normalized = normalizeHost(hostRaw, false);
      if (port === 0 || normalized === undefined) continue;
      this.add({ kind: 'domain', host: normalized.host, port });
      blank(start, end);
    }
  }
}

function urlHosts(authority: string): readonly string[] {
  const host = (value: string): string => {
    let s = value.slice(value.lastIndexOf('@') + 1);
    const i = indexOfAny(s, SHELL_META);
    if (i >= 0) s = s.slice(0, i);
    return s;
  };
  const out = [host(authority)];
  const i = indexOfAny(authority, SHELL_META);
  if (i >= 0) {
    out.push(host(authority.slice(0, i)));
    out.push(host(authority.split('\\').join('')));
  }
  return out;
}

function indexOfAny(value: string, set: string): number {
  for (let i = 0; i < value.length; i += 1) {
    if (set.includes(value[i] ?? '')) return i;
  }
  return -1;
}

function endsToken(chars: readonly string[], index: number): boolean {
  if (index >= chars.length) return true;
  const char = chars[index];
  if (isWord(char)) return false;
  return char !== '.' || index + 1 >= chars.length || !isWord(chars[index + 1]);
}

function isWord(char: string | undefined): boolean {
  if (char === undefined || char.length !== 1) return false;
  return /[A-Za-z0-9_]/.test(char);
}

function validPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return 0;
  return parsed;
}

export { targetName };
