import type { ToolCall, ToolMedia } from '@moonshot-ai/app-core/client/types';
import { BROWSER_RECEIPT_ID, browserToolData, type BrowserToolContext } from './browserToolPresentation';

export type BrowserValue =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'url'; url: string }
  | { type: 'keys'; keys: string[] }
  | { type: 'number'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'duration'; ms: number }
  | { type: 'time'; ms: number }
  | { type: 'bytes'; value: number }
  | { type: 'point'; x: number; y: number }
  | { type: 'size'; width: number; height: number }
  | { type: 'region'; x: number; y: number; width: number; height: number }
  | { type: 'element'; ref: string; name?: string };

export interface BrowserFact {
  key: string;
  value: BrowserValue;
}

export interface BrowserChange {
  key: string;
  before: BrowserValue;
  after: BrowserValue;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserMark =
  | { type: 'point'; x: number; y: number }
  | ({ type: 'box'; tone: 'primary' | 'secondary'; label?: string } & BrowserBounds)
  | { type: 'arrow'; from: { x: number; y: number }; to: { x: number; y: number } };

export interface BrowserRestEntry {
  source: 'args' | 'result';
  path: string;
  value: unknown;
}

export interface BrowserElementRow {
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  states: string[];
}

export interface BrowserTextBlock {
  id?: string;
  kind?: string;
  text: string;
  part?: number;
  continued?: boolean;
}

export interface BrowserCandidateRow {
  relation: 'target' | 'nearby';
  ref?: string;
  tagName?: string;
  role?: string;
  name?: string;
  id?: string;
  classes: string[];
  clickable?: boolean;
  disabled?: boolean;
  evidence?: string;
  bounds?: BrowserBounds;
}

export interface BrowserTabRow {
  tabId?: string;
  title?: string;
  url?: string;
  controlled?: boolean;
  visible?: boolean;
  loading?: boolean;
}

export type BrowserTableName = 'history' | 'downloads' | 'deviceProfiles';

export type BrowserSection =
  | { kind: 'error'; code: string; message: string; facts: BrowserFact[] }
  | { kind: 'request'; facts: BrowserFact[] }
  | { kind: 'receipt'; id: string }
  | { kind: 'result'; facts: BrowserFact[] }
  | { kind: 'shot'; origin: 'result' | 'snapshot'; media?: ToolMedia; width: number; height: number; marks: BrowserMark[]; facts: BrowserFact[] }
  | { kind: 'candidates'; rows: BrowserCandidateRow[] }
  | { kind: 'elements'; rows: BrowserElementRow[]; facts: BrowserFact[] }
  | { kind: 'text'; blocks: BrowserTextBlock[]; facts: BrowserFact[] }
  | { kind: 'table'; name: BrowserTableName; columns: string[]; rows: Array<Array<BrowserValue | null>> }
  | { kind: 'page'; title: string; url: string; compared: boolean; changes: BrowserChange[]; facts: BrowserFact[] }
  | { kind: 'tabs'; rows: BrowserTabRow[] };

export interface BrowserToolView {
  operation: string;
  sections: BrowserSection[];
  rest: BrowserRestEntry[];
  resultUnreadable: boolean;
}

type Segment = string | number;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathLabel(path: readonly Segment[]): string {
  return path.map((part, index) => typeof part === 'number' ? `[${part}]` : index === 0 ? part : `.${part}`).join('');
}

class Fields {
  private readonly used = new Set<string>();

  constructor(private readonly root: Record<string, unknown> | undefined, private readonly source: BrowserRestEntry['source']) {}

  peek(...path: Segment[]): unknown {
    let value: unknown = this.root;
    for (const part of path) {
      if (Array.isArray(value) && typeof part === 'number') value = value[part];
      else if (isRecord(value) && typeof part === 'string' && Object.hasOwn(value, part)) value = value[part];
      else return undefined;
    }
    return value;
  }

  use(...path: Segment[]): void {
    this.used.add(JSON.stringify(path));
  }

  str(...path: Segment[]): string | undefined {
    const value = this.peek(...path);
    if (typeof value !== 'string') return undefined;
    this.use(...path);
    return value;
  }

  num(...path: Segment[]): number | undefined {
    const value = this.peek(...path);
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    this.use(...path);
    return value;
  }

  bool(...path: Segment[]): boolean | undefined {
    const value = this.peek(...path);
    if (typeof value !== 'boolean') return undefined;
    this.use(...path);
    return value;
  }

  strings(...path: Segment[]): string[] | undefined {
    const value = this.peek(...path);
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
    this.use(...path);
    return value as string[];
  }

  count(...path: Segment[]): number | undefined {
    const value = this.peek(...path);
    if (!Array.isArray(value)) return undefined;
    if (value.length === 0) this.use(...path);
    return value.length;
  }

  point(...path: Segment[]): { x: number; y: number } | undefined {
    if (typeof this.peek(...path, 'x') !== 'number' || typeof this.peek(...path, 'y') !== 'number') return undefined;
    return { x: this.num(...path, 'x')!, y: this.num(...path, 'y')! };
  }

  size(...path: Segment[]): { width: number; height: number } | undefined {
    if (typeof this.peek(...path, 'width') !== 'number' || typeof this.peek(...path, 'height') !== 'number') return undefined;
    return { width: this.num(...path, 'width')!, height: this.num(...path, 'height')! };
  }

  bounds(...path: Segment[]): BrowserBounds | undefined {
    const keys = ['x', 'y', 'width', 'height'] as const;
    if (!keys.every((key) => typeof this.peek(...path, key) === 'number')) return undefined;
    const point = this.point(...path)!;
    return { ...point, ...this.size(...path)! };
  }

  rest(): BrowserRestEntry[] {
    const entries: BrowserRestEntry[] = [];
    const walk = (value: unknown, path: Segment[]) => {
      if (this.used.has(JSON.stringify(path))) return;
      if (Array.isArray(value) && value.some((item) => item !== null && typeof item === 'object')) {
        value.forEach((item, index) => walk(item, [...path, index]));
      } else if (isRecord(value) && Object.keys(value).length > 0) {
        for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
      } else {
        entries.push({ source: this.source, path: pathLabel(path), value });
      }
    };
    if (this.root !== undefined) for (const [key, value] of Object.entries(this.root)) walk(value, [key]);
    return entries;
  }
}

function fact(facts: BrowserFact[], key: string, value: BrowserValue | undefined): void {
  if (value !== undefined) facts.push({ key, value });
}

const text = (value: string | undefined): BrowserValue | undefined => value === undefined ? undefined : { type: 'text', text: value };
const code = (value: string | undefined): BrowserValue | undefined => value === undefined ? undefined : { type: 'code', text: value };
const link = (value: string | undefined): BrowserValue | undefined => value === undefined ? undefined : { type: 'url', url: value };
const number = (value: number | undefined): BrowserValue | undefined => value === undefined ? undefined : { type: 'number', value };
const bool = (value: boolean | undefined): BrowserValue | undefined => value === undefined ? undefined : { type: 'bool', value };
const duration = (value: number | undefined): BrowserValue | undefined => value === undefined ? undefined : { type: 'duration', ms: value };
const time = (value: number | undefined): BrowserValue | undefined => value === undefined ? undefined : { type: 'time', ms: value };
const bytes = (value: number | undefined): BrowserValue | undefined => value === undefined ? undefined : { type: 'bytes', value };
const point = (value: { x: number; y: number } | undefined): BrowserValue | undefined => value === undefined ? undefined : { type: 'point', ...value };
const size = (value: { width: number; height: number } | undefined): BrowserValue | undefined => value === undefined ? undefined : { type: 'size', ...value };
const region = (value: BrowserBounds | undefined): BrowserValue | undefined => value === undefined ? undefined : { type: 'region', ...value };

function requestFacts(operation: string, args: Fields, context: BrowserToolContext): BrowserFact[] {
  const facts: BrowserFact[] = [];
  if (operation.startsWith('page.element.')) {
    const ref = args.str('ref');
    if (ref !== undefined) facts.push({ key: 'target', value: { type: 'element', ref, name: context.element } });
  }
  fact(facts, 'url', link(args.str('url')));
  fact(facts, 'text', text(args.str('text')));
  fact(facts, 'replace', bool(args.bool('replace')));
  const keys = args.strings('keys');
  if (keys !== undefined) facts.push({ key: 'keys', value: { type: 'keys', keys } });
  fact(facts, 'optionValue', text(args.str('value')));
  fact(facts, 'optionLabel', text(args.str('label')));
  fact(facts, 'optionIndex', number(args.num('index')));
  fact(facts, 'checked', bool(args.bool('checked')));
  fact(facts, 'point', point(args.point()));
  fact(facts, 'from', point(args.point('from')));
  fact(facts, 'to', point(args.point('to')));
  fact(facts, 'deltaX', number(args.num('deltaX')));
  fact(facts, 'deltaY', number(args.num('deltaY')));
  fact(facts, 'button', code(args.str('button')));
  fact(facts, 'clickCount', number(args.num('clickCount')));
  fact(facts, 'radius', number(args.num('radius')));
  fact(facts, 'region', region(args.bounds('region')));
  fact(facts, 'loadState', code(args.str('state')));
  fact(facts, 'conditionKind', code(args.str('condition', 'kind')));
  fact(facts, 'locatorRole', code(args.str('condition', 'locator', 'role')));
  fact(facts, 'locatorName', text(args.str('condition', 'locator', 'name')));
  fact(facts, 'locatorExact', bool(args.bool('condition', 'locator', 'exact')));
  fact(facts, 'conditionState', code(args.str('condition', 'state')));
  fact(facts, 'conditionText', text(args.str('condition', 'text')));
  fact(facts, 'conditionValue', text(args.str('condition', 'value')));
  fact(facts, 'conditionMatch', code(args.str('condition', 'match')));
  fact(facts, 'timeout', duration(args.num('timeoutMs')));
  fact(facts, 'stableFor', duration(args.num('stableForMs')));
  fact(facts, 'scope', code(args.str('scope') ?? args.str('scope', 'kind')));
  const scopeRef = args.str('scope', 'ref');
  if (scopeRef !== undefined) facts.push({ key: 'scopeTarget', value: { type: 'element', ref: scopeRef } });
  fact(facts, 'filterRole', code(args.str('filter', 'role')));
  fact(facts, 'filterText', text(args.str('filter', 'text')));
  fact(facts, 'cursor', code(args.str('cursor')));
  fact(facts, 'deviceEnabled', bool(args.bool('device', 'enabled')));
  fact(facts, 'deviceProfile', code(args.str('device', 'profileId')));
  fact(facts, 'deviceOrientation', code(args.str('device', 'orientation')));
  return facts;
}

function evidenceFacts(fields: Fields, ...path: Segment[]): BrowserFact[] {
  const facts: BrowserFact[] = [];
  fact(facts, 'evidenceKind', code(fields.str(...path, 'kind')));
  fact(facts, 'evidenceValue', text(fields.str(...path, 'value')));
  fact(facts, 'evidenceCount', number(fields.num(...path, 'count')));
  fact(facts, 'evidenceScanTruncated', bool(fields.bool(...path, 'scanTruncated')));
  return facts;
}

function elementStates(result: Fields, path: Segment[]): string[] {
  const packed = result.str(...path, 'state');
  if (packed !== undefined) return packed.split(/\s+/).filter(Boolean);
  const states: string[] = [];
  if (result.bool(...path, 'disabled') === true) states.push('disabled');
  const checked = result.bool(...path, 'checked');
  if (checked !== undefined) states.push(checked ? 'checked' : 'unchecked');
  if (result.bool(...path, 'selected') === true) states.push('selected');
  const expanded = result.bool(...path, 'expanded');
  if (expanded !== undefined) states.push(expanded ? 'expanded' : 'collapsed');
  if (result.bool(...path, 'inViewport') === false) states.push('offscreen');
  return states;
}

function elementsSection(result: Fields): BrowserSection | undefined {
  const count = result.count('elements', 'elements');
  if (count === undefined) return undefined;
  const rows: BrowserElementRow[] = [];
  for (let i = 0; i < count; i++) {
    const path: Segment[] = ['elements', 'elements', i];
    const row = {
      ref: result.str(...path, 'ref'),
      role: result.str(...path, 'role'),
      name: result.str(...path, 'name'),
      text: result.str(...path, 'text'),
      value: result.str(...path, 'value'),
      states: elementStates(result, path),
    };
    for (const key of ['text', 'value', 'state']) if (result.peek(...path, key) === null) result.use(...path, key);
    rows.push(row);
  }
  const facts: BrowserFact[] = [];
  fact(facts, 'scope', code(result.str('elements', 'scope')));
  fact(facts, 'total', number(result.num('elements', 'total')));
  fact(facts, 'truncated', bool(result.bool('elements', 'truncated')));
  fact(facts, 'scanTruncated', bool(result.bool('elements', 'scanTruncated')));
  fact(facts, 'nextCursor', code(result.str('elements', 'nextCursor')));
  return { kind: 'elements', rows, facts };
}

function textSection(result: Fields): BrowserSection | undefined {
  const count = result.count('text', 'blocks');
  if (count === undefined) return undefined;
  const blocks: BrowserTextBlock[] = [];
  for (let i = 0; i < count; i++) {
    const path: Segment[] = ['text', 'blocks', i];
    blocks.push({
      id: result.str(...path, 'id'),
      kind: result.str(...path, 'kind'),
      text: result.str(...path, 'text') ?? '',
      part: result.num(...path, 'part'),
      continued: result.bool(...path, 'continued'),
    });
  }
  const facts: BrowserFact[] = [];
  fact(facts, 'scope', code(result.str('text', 'scope')));
  fact(facts, 'truncated', bool(result.bool('text', 'truncated')));
  fact(facts, 'scanTruncated', bool(result.bool('text', 'scanTruncated')));
  fact(facts, 'nextCursor', code(result.str('text', 'nextCursor')));
  fact(facts, 'capturedAt', time(result.num('text', 'capturedAt')));
  return { kind: 'text', blocks, facts };
}

function candidate(result: Fields, relation: BrowserCandidateRow['relation'], path: Segment[]): BrowserCandidateRow {
  return {
    relation,
    ref: result.str(...path, 'ref'),
    tagName: result.str(...path, 'tagName'),
    role: result.str(...path, 'role'),
    name: result.str(...path, 'name'),
    id: result.str(...path, 'id'),
    classes: result.strings(...path, 'classes') ?? [],
    clickable: result.bool(...path, 'clickable'),
    disabled: result.bool(...path, 'disabled'),
    evidence: result.str(...path, 'evidence'),
    bounds: result.bounds(...path, 'bounds'),
  };
}

function candidateRows(result: Fields): BrowserCandidateRow[] {
  const rows: BrowserCandidateRow[] = [];
  if (isRecord(result.peek('click', 'target'))) rows.push(candidate(result, 'target', ['click', 'target']));
  const nearby = result.count('click', 'nearby') ?? 0;
  for (let i = 0; i < nearby; i++) rows.push(candidate(result, 'nearby', ['click', 'nearby', i]));
  return rows;
}

const PAGE_FLAGS: Array<[field: string, key: string]> = [
  ['loading', 'loading'], ['canGoBack', 'canGoBack'], ['canGoForward', 'canGoForward'], ['active', 'controlled'], ['visible', 'visible'],
];

function pageSection(result: Fields, context: BrowserToolContext): BrowserSection | undefined {
  if (!isRecord(result.peek('tab'))) return undefined;
  const previous = context.previousTab;
  const title = result.str('tab', 'title') ?? '';
  if (previous === undefined) {
    const facts: BrowserFact[] = [];
    const url = result.str('tab', 'url') ?? '';
    for (const [field, key] of PAGE_FLAGS) fact(facts, key, bool(result.bool('tab', field)));
    return { kind: 'page', title, url, compared: false, changes: [], facts };
  }
  const changes: BrowserChange[] = [];
  if (typeof previous.title === 'string' && previous.title !== title) {
    changes.push({ key: 'pageTitle', before: { type: 'text', text: previous.title }, after: { type: 'text', text: title } });
  }
  const url = result.peek('tab', 'url');
  if (typeof url === 'string' && typeof previous.url === 'string' && previous.url !== url) {
    result.use('tab', 'url');
    changes.push({ key: 'pageUrl', before: { type: 'url', url: previous.url }, after: { type: 'url', url } });
  }
  for (const [field, key] of PAGE_FLAGS) {
    const before = previous[field];
    const after = result.peek('tab', field);
    if (typeof before !== 'boolean' || typeof after !== 'boolean' || before === after) continue;
    result.use('tab', field);
    changes.push({ key, before: { type: 'bool', value: before }, after: { type: 'bool', value: after } });
  }
  return { kind: 'page', title, url: '', compared: true, changes, facts: [] };
}

function tabsSection(result: Fields): BrowserSection | undefined {
  const count = result.count('browser', 'tabs');
  if (count === undefined) return undefined;
  const rows: BrowserTabRow[] = [];
  for (let i = 0; i < count; i++) {
    const path: Segment[] = ['browser', 'tabs', i];
    rows.push({
      tabId: result.str(...path, 'tabId'),
      title: result.str(...path, 'title'),
      url: result.str(...path, 'url'),
      controlled: result.bool(...path, 'active'),
      visible: result.bool(...path, 'visible'),
      loading: result.bool(...path, 'loading'),
    });
  }
  return { kind: 'tabs', rows };
}

type Cell = (result: Fields, path: Segment[]) => BrowserValue | undefined;

const TABLES: Array<{ name: BrowserTableName; columns: Array<[string, Cell]> }> = [
  {
    name: 'history',
    columns: [
      ['title', (result, path) => text(result.str(...path, 'title'))],
      ['url', (result, path) => link(result.str(...path, 'url'))],
      ['visitedAt', (result, path) => time(result.num(...path, 'visitedAt'))],
    ],
  },
  {
    name: 'downloads',
    columns: [
      ['filename', (result, path) => text(result.str(...path, 'filename'))],
      ['state', (result, path) => code(result.str(...path, 'state'))],
      ['received', (result, path) => bytes(result.num(...path, 'receivedBytes'))],
      ['total', (result, path) => bytes(result.num(...path, 'totalBytes'))],
      ['startedAt', (result, path) => time(result.num(...path, 'startedAt'))],
      ['url', (result, path) => link(result.str(...path, 'url'))],
      ['savePath', (result, path) => code(result.str(...path, 'savePath'))],
    ],
  },
  {
    name: 'deviceProfiles',
    columns: [
      ['profileId', (result, path) => code(result.str(...path, 'profileId'))],
      ['size', (result, path) => size(result.size(...path))],
      ['deviceScaleFactor', (result, path) => number(result.num(...path, 'deviceScaleFactor'))],
      ['mobile', (result, path) => bool(result.bool(...path, 'mobile'))],
      ['touch', (result, path) => bool(result.bool(...path, 'touch'))],
      ['orientation', (result, path) => code(result.str(...path, 'orientation'))],
    ],
  },
];

function tableSections(result: Fields): BrowserSection[] {
  const sections: BrowserSection[] = [];
  for (const table of TABLES) {
    const count = result.count(table.name);
    if (count === undefined) continue;
    const rows: Array<Array<BrowserValue | null>> = [];
    for (let i = 0; i < count; i++) rows.push(table.columns.map(([, cell]) => cell(result, [table.name, i]) ?? null));
    sections.push({ kind: 'table', name: table.name, columns: table.columns.map(([name]) => name), rows });
  }
  return sections;
}

function snapshotMarks(operation: string, args: Fields, candidates: BrowserCandidateRow[]): BrowserMark[] {
  const marks: BrowserMark[] = [];
  const at = args.point();
  if (operation === 'page.visual.crop') {
    const box = args.bounds('region');
    if (box !== undefined) marks.push({ type: 'box', ...box, tone: 'primary' });
  } else if (operation === 'page.visual.drag') {
    const from = args.point('from');
    const to = args.point('to');
    if (from !== undefined && to !== undefined) marks.push({ type: 'arrow', from, to });
  } else if (operation === 'page.visual.scroll') {
    const deltaX = args.num('deltaX') ?? 0;
    const deltaY = args.num('deltaY') ?? 0;
    if (at !== undefined) marks.push(deltaX || deltaY ? { type: 'arrow', from: at, to: { x: at.x + deltaX, y: at.y + deltaY } } : { type: 'point', ...at });
  } else {
    for (const relation of ['nearby', 'target'] as const) {
      for (const row of candidates) {
        if (row.relation === relation && row.bounds !== undefined) {
          marks.push({ type: 'box', ...row.bounds, tone: relation === 'target' ? 'primary' : 'secondary', label: row.ref });
        }
      }
    }
    if (at !== undefined) marks.push({ type: 'point', ...at });
  }
  return marks;
}

export function browserToolView(
  tool: Pick<ToolCall, 'arg' | 'output' | 'resultText' | 'status'> & { id?: string; media?: ToolMedia },
  context: BrowserToolContext,
): BrowserToolView | undefined {
  const data = browserToolData(tool);
  if (data.args === undefined) return undefined;
  const args = new Fields(data.args, 'args');
  const result = new Fields(data.result, 'result');
  const operation = typeof data.args.operation === 'string' ? data.args.operation : '';
  const sections: BrowserSection[] = [];

  if (isRecord(result.peek('error'))) {
    sections.push({
      kind: 'error',
      code: result.str('error', 'code') ?? '',
      message: result.str('error', 'message') ?? '',
      facts: evidenceFacts(result, 'error', 'lastObserved'),
    });
  }

  const request = requestFacts(operation, args, context);
  if (request.length > 0) sections.push({ kind: 'request', facts: request });
  const receipt = result.peek('receipt');
  if (typeof receipt === 'string' && BROWSER_RECEIPT_ID.test(receipt)) sections.push({ kind: 'receipt', id: result.str('receipt')! });

  const candidates = candidateRows(result);
  if (context.shot !== undefined) {
    const marks = snapshotMarks(operation, args, candidates);
    if (marks.length > 0) sections.push({ kind: 'shot', origin: 'snapshot', ...context.shot, marks, facts: [] });
  }
  if (candidates.length > 0) sections.push({ kind: 'candidates', rows: candidates });

  const elements = elementsSection(result);
  if (elements !== undefined) sections.push(elements);
  const textBlocks = textSection(result);
  if (textBlocks !== undefined) sections.push(textBlocks);
  sections.push(...tableSections(result));

  const facts: BrowserFact[] = [];
  fact(facts, 'matched', bool(result.bool('wait', 'matched')));
  fact(facts, 'elapsed', duration(result.num('wait', 'elapsedMs')));
  facts.push(...evidenceFacts(result, 'wait', 'evidence'));
  fact(facts, 'outcome', code(result.str('click', 'outcome')));
  fact(facts, 'message', text(result.str('click', 'message')));
  fact(facts, 'searchRadius', number(result.num('click', 'radius')));
  fact(facts, 'candidatesTruncated', bool(result.bool('click', 'truncated')));
  fact(facts, 'needsVisualConfirmation', bool(result.bool('click', 'needsVisualConfirmation')));
  fact(facts, 'available', bool(result.bool('browser', 'available')));
  fact(facts, 'panelVisible', bool(result.bool('browser', 'panelVisible')));
  fact(facts, 'controlledTab', code(result.str('browser', 'activeTabId')));
  fact(facts, 'visibleTab', code(result.str('browser', 'visibleTabId')));
  if (facts.length > 0) sections.push({ kind: 'result', facts });

  for (const key of ['visual', 'crop'] as const) {
    const image = result.size(key);
    if (image === undefined) continue;
    const shot: BrowserFact[] = [];
    fact(shot, 'imageSize', size(image));
    fact(shot, 'viewport', size(result.size(key, 'viewport')));
    fact(shot, 'deviceScaleFactor', number(result.num(key, 'deviceScaleFactor')));
    fact(shot, 'cropAvailable', bool(result.bool(key, 'cropAvailable')));
    fact(shot, 'region', region(result.bounds(key, 'region')));
    fact(shot, 'capturedAt', time(result.num(key, 'capturedAt')));
    sections.push({ kind: 'shot', origin: 'result', media: tool.media, ...image, marks: [], facts: shot });
  }

  const page = pageSection(result, context);
  if (page !== undefined) sections.push(page);
  else if (context.page) sections.push({ kind: 'page', title: context.page, url: '', compared: false, changes: [], facts: [] });
  const tabs = tabsSection(result);
  if (tabs !== undefined) sections.push(tabs);

  const hasOutput = tool.output?.some((line) => line.trim().length > 0) === true;
  return {
    operation,
    sections,
    rest: [...args.rest(), ...result.rest()],
    resultUnreadable: tool.status !== 'running' && hasOutput && data.result === undefined,
  };
}
