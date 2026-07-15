/**
 * URL query-string reader for the dep-graph viewer. Lets a link deep-link into
 * a specific slice of the graph — e.g. `?domain=session,sessionMetadata` shows
 * only those domains, `?scope=Session&kind=ctor` narrows to ctor edges at
 * Session scope, and `?focus=Session::IMyService` pre-selects a node.
 *
 * The mapping is one-way on load: the URL seeds the initial filter state and
 * subsequent UI interaction does NOT write back to the URL. Parsed values are
 * validated against the known scope/kind vocabularies; unknown tokens are
 * dropped rather than crashing the viewer.
 */
import type { EdgeKind, ServiceScope } from '../../analyzer/types';
import { EDGE_KINDS } from './style';

const ALL_SCOPES: readonly ServiceScope[] = ['App', 'Session', 'Agent'];

export interface QueryParams {
  domains?: string[];
  scopes?: ServiceScope[];
  kinds?: EdgeKind[];
  search?: string;
  hideOrphans?: boolean;
  groupByScope?: boolean;
  focus?: string;
}

export function readQueryParams(search: string): QueryParams {
  const params = new URLSearchParams(search);
  const out: QueryParams = {};

  const domains = parseList(params.get('domain'));
  if (domains !== undefined) out.domains = domains;

  const scopes = filterValid(parseList(params.get('scope')), isScope);
  if (scopes !== undefined) out.scopes = scopes;

  const kinds = filterValid(parseList(params.get('kind')), isKind);
  if (kinds !== undefined) out.kinds = kinds;

  const searchValue = params.get('search');
  if (searchValue !== null && searchValue !== '') out.search = searchValue;

  if (params.has('hideOrphans')) out.hideOrphans = parseBool(params.get('hideOrphans'));
  if (params.has('groupByScope')) out.groupByScope = parseBool(params.get('groupByScope'));

  const focus = params.get('focus');
  if (focus !== null && focus !== '') out.focus = focus;

  return out;
}

function parseList(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  const items = [
    ...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)),
  ];
  return items.length > 0 ? items : undefined;
}

function filterValid<T extends string>(
  items: string[] | undefined,
  guard: (s: string) => s is T,
): T[] | undefined {
  if (items === undefined) return undefined;
  const valid = items.filter(guard);
  return valid.length > 0 ? valid : undefined;
}

function isScope(s: string): s is ServiceScope {
  return (ALL_SCOPES as readonly string[]).includes(s);
}

function isKind(s: string): s is EdgeKind {
  return (EDGE_KINDS as readonly string[]).includes(s);
}

function parseBool(raw: string | null): boolean {
  if (raw === null || raw === '') return true;
  return !/^(false|0|no|off)$/i.test(raw.trim());
}
