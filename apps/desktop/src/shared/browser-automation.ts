import { BrowserIdSchema } from './browser-schema';
import { Type, type Static, type TProperties } from 'typebox';
import { Value } from 'typebox/value';

import type { BrowserHistoryEntry, BrowserDownloadEntry } from './browser-data';
import { BROWSER_PAGE_DIALOG_TEXT_MAX, type BrowserDialogRecord, type BrowserPageDialogKind, type BrowserPendingDialog } from './browser-dialogs';
import { BrowserDeviceModeRequestSchema } from './browser-device';
import { browserAddressKind, type BrowserSearchEngine } from './browser-search';
import { BROWSER_STATE_URL_MAX, type BrowserState } from './browser';

export const BROWSER_AUTOMATION_PROTOCOL = 'kimi.browser/1.0.0' as const;
export const BROWSER_DRAG_PATH_MAX_POINTS = 500;

const Id = BrowserIdSchema;
const Tab = { tabId: Type.String({ ...Id, description: 'Required on every call targeting a tab. Copy tabId from browser.get_state or browser.create_tab; there is no implicit current tab.' }) };
const Visual = { ...Tab, snapshotId: Type.String({ ...Id, description: 'Snapshot id from the same tab. Visual actions require page.visual.snapshot; element actions require page.elements.snapshot.' }) };
const Element = { ...Visual, ref: Type.String({ ...Id, description: 'Element ref returned by page.elements.snapshot, never a label or selector.' }) };
const Point = Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false });
const PathPoints = Type.Array(Point, { minItems: 2, maxItems: BROWSER_DRAG_PATH_MAX_POINTS, description: 'For page.visual.drag_path: ordered [{x,y}] points in returned screenshot pixels. The button is pressed at the first point, held while moving through every point, and released at the last point. Repeat the first point at the end to close a shape.' });
const Modifiers = Type.Array(Type.Enum(['Alt', 'Control', 'Meta', 'Shift']), { minItems: 1, maxItems: 4, uniqueItems: true, description: 'Modifier keys held during the drag, such as ["Shift"].' });
const LoadState = Type.Union([Type.Literal('committed'), Type.Literal('dom_ready'), Type.Literal('complete')]);
const MouseButton = Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')]);
const Text = Type.String({ description: 'Text to enter. Use text, not value.' });
const Keys = Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { minItems: 1, maxItems: 8, description: 'A key chord such as ["ControlOrMeta", "A"] or ["Enter"].' });
const Url = Type.String({ minLength: 1, maxLength: BROWSER_STATE_URL_MAX, description: 'HTTP(S) URL for create_tab or navigate.' });
const DialogId = Type.String({ ...Id, description: 'dialogId of a pending dialog, from pendingDialogs in any browser result or from page.dialog.get.' });
const DialogFiles = Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 32, description: 'For a file dialog: absolute paths of local files to upload. Files outside the workspace and Downloads may need the user\'s approval.' });
const Query = Type.String({ minLength: 1, maxLength: 1024, description: "Search text, searched with the user's configured search engine." });

const PageScope = Type.Object({ kind: Type.Enum(['viewport', 'document']) }, { additionalProperties: false });
const TextScope = Type.Union([
  PageScope,
  Type.Object({ kind: Type.Literal('element'), snapshotId: Id, ref: Id }, { additionalProperties: false }),
], { description: 'For page.text.snapshot: {kind:"viewport"} (default), {kind:"document"}, or {kind:"element",snapshotId,ref}.' });
const ElementsScope = Type.Object(PageScope.properties, { additionalProperties: false, description: 'For page.elements.snapshot: {kind:"viewport"} (default) or {kind:"document"}.' });
export type BrowserTextScope = Static<typeof TextScope>;
export type BrowserElementsScope = Static<typeof ElementsScope>;

const WaitCondition = Type.Union([
  Type.Object({ kind: Type.Literal('element'), locator: Type.Object({ role: Type.String({ minLength: 1, maxLength: 128 }), name: Type.Optional(Type.String({ maxLength: 512 })), exact: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), state: Type.Enum(['visible', 'hidden', 'enabled']) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('text'), text: Type.String({ minLength: 1, maxLength: 512 }), match: Type.Optional(Type.Enum(['exact', 'contains'])), state: Type.Enum(['present', 'absent']) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('url'), value: Type.String({ minLength: 1, maxLength: 4096 }), match: Type.Enum(['exact', 'prefix']) }, { additionalProperties: false }),
], { description: 'Exactly one of {kind:"element",locator:{role,name?,exact?},state:"visible"|"hidden"|"enabled"}, {kind:"text",text,match?:"exact"|"contains",state:"present"|"absent"}, or {kind:"url",value,match:"exact"|"prefix"}.' });
export type BrowserWaitCondition = Static<typeof WaitCondition>;

function request<const Operation extends string, Properties extends TProperties>(operation: Operation, properties: Properties) {
  return Type.Object({ protocol: Type.Literal(BROWSER_AUTOMATION_PROTOCOL), operation: Type.Literal(operation), ...properties }, { additionalProperties: false });
}

const Requests = [
  request('browser.get_history', {}),
  request('browser.get_downloads', {}),
  request('browser.get_device_profiles', {}),
  request('tab.set_device_mode', { ...Tab, device: BrowserDeviceModeRequestSchema }),
  request('browser.get_state', {}),
  request('browser.activate_panel', {}),
  request('browser.create_tab', { url: Type.Optional(Url), query: Type.Optional(Query) }),
  request('browser.release_tab', Tab),
  request('browser.activate_tab', Tab),
  request('browser.switch_tab', Tab),
  request('browser.close_tab', Tab),
  request('tab.get_state', Tab),
  request('tab.navigate', { ...Tab, url: Url }),
  request('tab.search', { ...Tab, query: Query }),
  request('tab.go_back', Tab),
  request('tab.go_forward', Tab),
  request('tab.reload', Tab),
  request('tab.stop_loading', Tab),
  request('tab.wait_for_load', { ...Tab, state: LoadState, timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000 })) }),
  request('page.wait_for', { ...Tab, condition: WaitCondition, timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30000 })), stableForMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 5000 })) }),
  request('page.text.snapshot', { ...Tab, scope: Type.Optional(TextScope), maxChars: Type.Optional(Type.Integer({ minimum: 2048, maximum: 24000 })) }),
  request('page.text.snapshot', { ...Tab, cursor: Type.String({ minLength: 1, maxLength: 128 }) }),
  request('page.visual.snapshot', Tab),
  request('page.visual.crop', { ...Visual, region: Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }), width: Type.Number({ exclusiveMinimum: 0 }), height: Type.Number({ exclusiveMinimum: 0 }) }, { additionalProperties: false }) }),
  request('page.visual.click', { ...Visual, ...Point.properties, button: Type.Optional(MouseButton), clickCount: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)])) }),
  request('page.visual.click_if_interactive', { ...Visual, ...Point.properties, radius: Type.Optional(Type.Integer({ minimum: 8, maximum: 128, description: 'Nearby search radius in returned screenshot pixels; defaults to 48. Nearby candidates are never clicked automatically.' })) }),
  request('page.visual.hover', { ...Visual, ...Point.properties }),
  request('page.visual.scroll', { ...Visual, ...Point.properties, deltaX: Type.Number(), deltaY: Type.Number() }),
  request('page.visual.drag', { ...Visual, from: Point, to: Point }),
  request('page.visual.drag_path', { ...Visual, points: PathPoints, button: Type.Optional(MouseButton), durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 20000, description: 'Total movement time for page.visual.drag_path; defaults to about 8 ms per interpolated move, capped at 5000.' })), modifiers: Type.Optional(Modifiers) }),
  request('page.visual.type_text', { ...Tab, text: Text, replace: Type.Optional(Type.Boolean()) }),
  request('page.visual.press_key', { ...Tab, keys: Keys }),
  request('page.elements.snapshot', { ...Tab, scope: Type.Optional(ElementsScope),
    filter: Type.Optional(Type.Object({ role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), text: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }, { additionalProperties: false })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })), maxChars: Type.Optional(Type.Integer({ minimum: 2048, maximum: 24000 })),
  }),
  request('page.elements.snapshot', { ...Tab, cursor: Type.String({ minLength: 1, maxLength: 128 }) }),
  request('page.element.click', Element),
  request('page.element.hover', Element),
  request('page.element.fill', { ...Element, text: Text }),
  request('page.element.type_text', { ...Element, text: Text }),
  request('page.element.press_key', { ...Element, keys: Keys }),
  request('page.element.select_option', { ...Element, value: Type.String(), label: Type.Optional(Type.Never()), index: Type.Optional(Type.Never()) }),
  request('page.element.select_option', { ...Element, value: Type.Optional(Type.Never()), label: Type.String(), index: Type.Optional(Type.Never()) }),
  request('page.element.select_option', { ...Element, value: Type.Optional(Type.Never()), label: Type.Optional(Type.Never()), index: Type.Integer({ minimum: 0 }) }),
  request('page.element.set_checked', { ...Element, checked: Type.Boolean() }),
  request('page.element.scroll_into_view', Element),
  request('page.dialog.get', Tab),
  request('page.dialog.respond', { ...Tab, dialogId: DialogId,
    accept: Type.Boolean({ description: 'true to accept (OK, Leave, upload the files), false to dismiss (Cancel, Stay, no upload).' }),
    files: Type.Optional(DialogFiles),
    text: Type.Optional(Type.String({ maxLength: BROWSER_PAGE_DIALOG_TEXT_MAX, description: 'For a prompt dialog with accept=true: the text the page receives. Omit it to keep the defaultValue.' })),
  }),
] as const;

export const BROWSER_RUN_INPUT_SCHEMA = Type.Union([...Requests], { type: 'object', required: ['protocol', 'operation'] });
export type BrowserRunRequest = Static<typeof BROWSER_RUN_INPUT_SCHEMA>;
export type BrowserOperation = BrowserRunRequest['operation'];
export type BrowserPoint = Static<typeof Point>;
export type BrowserLoadState = Static<typeof LoadState>;
export type BrowserMouseButton = Static<typeof MouseButton>;

export const BROWSER_OPERATIONS = [...new Set(Requests.map(schema => schema.properties.operation.const))];
const OperationBranches = new Map(BROWSER_OPERATIONS.map(operation => [operation, Requests.filter(schema => schema.properties.operation.const === operation)]));

export const BROWSER_OPERATION_PARAMETERS = Object.fromEntries(BROWSER_OPERATIONS.map(operation => {
  const branches = Requests.filter(schema => schema.properties.operation.const === operation);
  const fields = [...new Set(branches.flatMap(schema => Object.keys(schema.properties)))].filter(key => key !== 'protocol' && key !== 'operation');
  const required = fields.filter(key => branches.every(schema => (schema.required as string[]).includes(key)));
  const alternatives = branches.map(schema => (schema.required as string[]).filter(key => key !== 'protocol' && key !== 'operation' && !required.includes(key)));
  return [operation, { required, optional: fields.filter(key => !required.includes(key)), alternatives }];
})) as Record<BrowserOperation, { required: string[]; optional: string[]; alternatives: string[][] }>;

function alternativesClause(operation: BrowserOperation): string {
  const { alternatives } = BROWSER_OPERATION_PARAMETERS[operation];
  if (alternatives.length < 2) return '';
  if (alternatives.every(fields => fields.length > 0)) return `; supply exactly one of ${[...new Set(alternatives.flat())].join(', ')}`;
  const branches = OperationBranches.get(operation) ?? [];
  return alternatives.map((fields, index) => {
    if (fields.length === 0) return '';
    const own = branches[index]!;
    const conflicts = [...new Set(branches.flatMap(branch => branch === own ? [] : Object.keys(branch.properties).filter(key => acceptsField(branch, key) && !acceptsField(own, key))))];
    return conflicts.length > 0 ? `; ${fields.join(', ')} cannot be combined with ${conflicts.join(', ')}` : '';
  }).join('');
}

export function browserOperationParameters(operation: BrowserOperation): string {
  const { required, optional } = BROWSER_OPERATION_PARAMETERS[operation];
  const selection = alternativesClause(operation);
  return `${operation}: required [protocol, operation${required.length ? `, ${required.join(', ')}` : ''}]; optional [${optional.join(', ')}]${selection}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface BrowserRunRequestOptions {
  isLocalFileAddress?: (value: string) => boolean;
}

function runtimeProblems(value: Record<string, unknown>, options: BrowserRunRequestOptions): string[] {
  const { url, query } = value;
  const problems: string[] = [];
  if (typeof url === 'string' && browserAddressKind(url.trim()) === 'search' && options.isLocalFileAddress?.(url) !== true) {
    problems.push(`/url: ${JSON.stringify(url)} is not an http(s) URL or host name; send the full URL, such as https://example.com/, or use query to search.`);
  }
  if (typeof query === 'string' && query.trim() === '') problems.push('/query: must contain a non-whitespace character.');
  if (url !== undefined && query !== undefined) problems.push('Send either url or query, not both.');
  return problems;
}

const SCOPED_OPERATIONS = new Set<unknown>(['page.text.snapshot', 'page.elements.snapshot']);

function normalizeScope(scope: string): unknown {
  const text = scope.trim();
  if (text === 'viewport' || text === 'document') return { kind: text };
  if (!text.startsWith('{')) return scope;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : scope;
  } catch {
    return scope;
  }
}

function normalizeBrowserRunRequest(value: unknown): unknown {
  if (!isRecord(value) || !SCOPED_OPERATIONS.has(value['operation'])) return value;
  const scope = value['scope'];
  return typeof scope === 'string' ? { ...value, scope: normalizeScope(scope) } : value;
}

export function asBrowserRunRequest(value: unknown, options: BrowserRunRequestOptions = {}): BrowserRunRequest | null {
  const request = normalizeBrowserRunRequest(value);
  return Value.Check(BROWSER_RUN_INPUT_SCHEMA, request) && runtimeProblems(request, options).length === 0 ? request : null;
}

type SchemaNode = Record<string, unknown>;
type SchemaError = ReturnType<typeof Value.Errors>[number];

function schemaAt(root: unknown, schemaPath: string): SchemaNode {
  let node = root;
  for (const segment of schemaPath.replace(/^#\/?/, '').split('/').filter(Boolean)) {
    node = (node as Record<string, unknown> | undefined)?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return isRecord(node) ? node : {};
}

function valueAt(root: unknown, instancePath: string): unknown {
  let value = root;
  for (const segment of instancePath.split('/').filter(Boolean)) {
    value = isRecord(value) || Array.isArray(value) ? (value as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
  }
  return value;
}

function withArticle(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return withArticle(typeof value);
}

function schemaType(node: SchemaNode): string | undefined {
  if (typeof node['type'] === 'string') return node['type'];
  const values = node['enum'] ?? ('const' in node ? [node['const']] : undefined);
  return Array.isArray(values) && values.length > 0 ? typeof values[0] : undefined;
}

function matchesType(node: SchemaNode, value: unknown): boolean {
  const type = schemaType(node);
  if (type === undefined) return true;
  if (type === 'object') return isRecord(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function literalValues(node: SchemaNode): unknown[] | undefined {
  if ('const' in node) return [node['const']];
  return Array.isArray(node['enum']) ? node['enum'] : undefined;
}

function kindsOf(node: SchemaNode): unknown[] {
  const kind = (node['properties'] as Record<string, SchemaNode> | undefined)?.['kind'];
  if (kind === undefined) return [];
  if ('const' in kind) return [kind['const']];
  return Array.isArray(kind['enum']) ? kind['enum'] : [];
}

function placeholder(key: string, node: SchemaNode): string {
  const values = node['enum'] ?? ('const' in node ? [node['const']] : undefined);
  if (Array.isArray(values) && values.length > 0) return JSON.stringify(values[0]);
  const type = schemaType(node);
  if (type === 'object') return '{…}';
  if (type === 'array') return '[…]';
  if (type === 'number' || type === 'integer') return '0';
  if (type === 'boolean') return 'true';
  return JSON.stringify(`<${key}>`);
}

function examplesOf(node: SchemaNode): string[] {
  const variants = Array.isArray(node['anyOf']) ? (node['anyOf'] as SchemaNode[]) : [node];
  return variants.flatMap(variant => {
    const properties = (variant['properties'] ?? {}) as Record<string, SchemaNode>;
    const required = ((variant['required'] ?? []) as string[]).filter(key => key !== 'kind');
    return kindsOf(variant).map(kind => `{${[`"kind":${JSON.stringify(kind)}`, ...required.map(key => `"${key}":${placeholder(key, properties[key] ?? {})}`)].join(',')}}`);
  });
}

function expectation(node: SchemaNode): string {
  const examples = examplesOf(node);
  if (examples.length > 0) {
    const listed = examples.length === 1 ? examples[0] : `${examples.slice(0, -1).join(', ')} or ${examples.at(-1)}`;
    return `an object like ${listed}`;
  }
  const types = [...new Set((Array.isArray(node['anyOf']) ? (node['anyOf'] as SchemaNode[]) : [node]).map(schemaType).filter(type => type !== undefined))];
  return types.length > 0 ? types.map(withArticle).join(' or ') : 'a valid value';
}

function instancePathOf(schemaPath: string, errors: SchemaError[]): string {
  const segments = schemaPath.replace(/^#/, '').split('/').filter(Boolean);
  if (segments.length % 2 === 0 && segments.every((segment, index) => index % 2 === 1 || segment === 'properties')) {
    return segments.filter((_, index) => index % 2 === 1).map(segment => `/${segment}`).join('');
  }
  return errors.map(error => error.instancePath).sort((left, right) => left.length - right.length)[0] ?? '';
}

function formatSchemaError(root: unknown, value: unknown, error: SchemaError): string {
  const path = error.instancePath || '/';
  const actual = valueAt(value, error.instancePath);
  const node = schemaAt(root, error.schemaPath);
  if (error.keyword === 'type') return `${path}: expected ${expectation(node)}, got ${jsonType(actual)}`;
  if (error.keyword === 'enum' && Array.isArray(node['enum'])) return `${path}: expected one of ${node['enum'].map(item => JSON.stringify(item)).join(', ')}, got ${JSON.stringify(actual)}`;
  if (error.keyword === 'const') return `${path}: expected ${JSON.stringify(node['const'])}, got ${JSON.stringify(actual)}`;
  if (error.keyword === 'boolean') return `${path}: not accepted here`;
  return `${path}: ${error.message}`;
}

function formatUnionErrors(root: unknown, value: unknown, base: string, errors: SchemaError[]): string[] {
  const node = schemaAt(root, base);
  const variants = (node['anyOf'] ?? []) as SchemaNode[];
  const instancePath = instancePathOf(base, errors);
  const path = instancePath || '/';
  const actual = valueAt(value, instancePath);
  const kinds = variants.flatMap(kindsOf);
  const inVariant = (index: number) => errors.filter(error => error.schemaPath === `${base}/anyOf/${index}` || error.schemaPath.startsWith(`${base}/anyOf/${index}/`));
  const literals = variants.map(literalValues);
  if (literals.every(values => values !== undefined)) {
    return [`${path}: expected one of ${[...new Set(literals.flat())].map(item => JSON.stringify(item)).join(', ')}, got ${JSON.stringify(actual)}`];
  }
  let variant = -1;
  if (isRecord(actual) && kinds.length > 0) {
    const kind = actual['kind'];
    variant = variants.findIndex(candidate => kindsOf(candidate).includes(kind));
    if (variant < 0) return [`${path}/kind: expected one of ${kinds.map(item => JSON.stringify(item)).join(', ')}, got ${kind === undefined ? 'nothing' : JSON.stringify(kind)}`];
  } else {
    const candidates = variants.map((candidate, index) => {
      const nested = inVariant(index);
      return { index, mismatched: nested.filter(error => error.keyword === 'const' || error.keyword === 'enum').length, count: nested.length };
    }).filter(({ index }) => matchesType(variants[index]!, actual));
    variant = candidates.sort((left, right) => left.mismatched - right.mismatched || left.count - right.count)[0]?.index ?? -1;
  }
  const nested = variant < 0 ? [] : inVariant(variant);
  if (nested.length === 0) return [`${path}: expected ${expectation(node)}, got ${jsonType(actual)}`];
  const messages = formatSchemaErrors(root, value, nested, `${base}/anyOf/${variant}`.length);
  const description = node['description'];
  return kinds.length === 0 && typeof description === 'string' ? [...messages, `(${description})`] : messages;
}

function formatSchemaErrors(root: unknown, value: unknown, errors: SchemaError[], offset = 0): string[] {
  const messages: string[] = [];
  const unions = new Set<string>();
  const rejected = errors.filter(error => error.keyword === 'boolean').map(error => error.instancePath);
  for (const error of errors) {
    const index = error.schemaPath.indexOf('/anyOf/', offset);
    if (index >= 0) unions.add(error.schemaPath.slice(0, index));
    else if (error.keyword === 'anyOf') unions.add(error.schemaPath);
    else if (error.keyword !== 'additionalProperties' || !rejected.some(path => path.startsWith(`${error.instancePath}/`))) messages.push(formatSchemaError(root, value, error));
  }
  for (const base of unions) {
    messages.push(...formatUnionErrors(root, value, base, errors.filter(error => error.schemaPath.startsWith(`${base}/anyOf/`))));
  }
  return [...new Set(messages)];
}

function acceptsField(branch: (typeof Requests)[number], key: string): boolean {
  const property = (branch.properties as Record<string, object>)[key];
  return property !== undefined && !('not' in property);
}

function describeOperationErrors(operation: BrowserOperation, value: Record<string, unknown>): string[] {
  const keys = Object.keys(value).filter(key => key !== 'protocol' && key !== 'operation');
  const [best] = (OperationBranches.get(operation) ?? []).map(branch => ({
    branch,
    extra: keys.filter(key => !acceptsField(branch, key)),
    missing: (branch.required as string[]).filter(key => value[key] === undefined),
    errors: [...Value.Errors(branch, value)],
  })).sort((left, right) => left.extra.length - right.extra.length || left.missing.length - right.missing.length || left.errors.length - right.errors.length);
  if (best === undefined) return [];
  if (best.extra.length > 0) {
    const kept = keys.filter(key => !best.extra.includes(key) && !BROWSER_OPERATION_PARAMETERS[operation].required.includes(key));
    return [`${best.extra.join(', ')} cannot be combined with ${kept.join(', ')}.`];
  }
  if (best.missing.length > 0) return [`Supply exactly one of ${[...new Set(BROWSER_OPERATION_PARAMETERS[operation].alternatives.flat())].join(', ')}.`];
  return formatSchemaErrors(best.branch, value, best.errors);
}

export function describeInvalidBrowserRunRequest(input: unknown, options: BrowserRunRequestOptions = {}): string {
  const prefix = `Invalid ${BROWSER_AUTOMATION_PROTOCOL} request.`;
  const value = normalizeBrowserRunRequest(input);
  if (!isRecord(value)) return `${prefix} Expected an object with protocol and operation.`;
  if (value['protocol'] !== BROWSER_AUTOMATION_PROTOCOL) return `${prefix} protocol must be "${BROWSER_AUTOMATION_PROTOCOL}".`;
  const operation = value['operation'] as BrowserOperation;
  if (!OperationBranches.has(operation)) return `${prefix} operation must be one of: ${BROWSER_OPERATIONS.join(', ')}.`;
  const { required, optional } = BROWSER_OPERATION_PARAMETERS[operation];
  const missing = required.filter(key => value[key] === undefined);
  const allowed = new Set(['protocol', 'operation', ...required, ...optional]);
  const unexpected = Object.keys(value).filter(key => !allowed.has(key));
  const problems = [
    ...(missing.length ? [`Missing required parameters: ${missing.join(', ')}.`] : []),
    ...(unexpected.length ? [`Unexpected parameters: ${unexpected.join(', ')}.`] : []),
  ];
  if (missing.includes('tabId')) problems.push('Get tabId from browser.get_state or browser.create_tab and include it explicitly.');
  if (problems.length === 0) {
    problems.push(...describeOperationErrors(operation, value));
    problems.push(...runtimeProblems(value, options));
  }
  return `${prefix} ${problems.join(' ')} ${browserOperationParameters(operation)}`;
}

export interface BrowserTabSnapshot extends Omit<BrowserState, 'favicon'> {
  tabId: string;
  browserId: string;
  active: boolean;
  visible: boolean;
  generation: number;
}

export interface BrowserSnapshot {
  available: boolean;
  panelVisible: boolean;
  activeTabId: string | null;
  visibleTabId: string | null;
  tabs: BrowserTabSnapshot[];
}

export interface BrowserVisualCrop {
  sourceSnapshotId: string;
  capturedAt: number;
  region: BrowserElementBounds;
  mimeType: 'image/png';
  data: string;
  width: number;
  height: number;
}

export interface BrowserVisualSnapshot {
  cropAvailable?: boolean;
  snapshotId: string;
  mimeType: 'image/png';
  data: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  viewport: { width: number; height: number };
}

export interface BrowserElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserElementSnapshotItem {
  ref: string;
  role: string;
  name: string;
  text?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  inViewport: boolean;
  bounds: BrowserElementBounds;
}

export interface BrowserElementsSnapshot {
  snapshotId: string;
  elements: BrowserElementSnapshotItem[];
  truncated?: boolean;
  scanTruncated?: boolean;
  scope?: 'viewport' | 'document';
  total?: number;
  nextCursor?: string | null;
  maxChars?: number;
}

export interface BrowserTextSnapshot {
  snapshotId: string;
  source: 'dom';
  scope: BrowserTextScope['kind'];
  capturedAt: number;
  blocks: Array<{ id: string; kind: string; text: string; part: number; continued: boolean }>;
  scanTruncated: boolean;
  truncated: boolean;
  nextCursor: string | null;
  maxChars: number;
}

export interface BrowserWaitEvidence {
  kind: BrowserWaitCondition['kind'];
  value: string;
  count?: number;
  scanTruncated?: boolean;
}
export interface BrowserWaitResult {
  matched: true;
  elapsedMs: number;
  evidence: BrowserWaitEvidence;
}

export const BROWSER_LOCAL_FILE_REFUSAL = 'This tab shows a local file the user opened. Browser tools cannot read, capture or control local file pages; ask the user to describe what they see instead.';

export type BrowserErrorCode =
  | 'SNAPSHOT_EXPIRED'
  | 'OUTPUT_LIMIT'
  | 'BROWSER_USER_TAKEOVER'
  | 'BROWSER_SUBAGENT_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'BROWSER_UNAVAILABLE'
  | 'TAB_NOT_FOUND'
  | 'TAB_NOT_ACTIVE'
  | 'NAVIGATION_FAILED'
  | 'CANNOT_GO_BACK'
  | 'CANNOT_GO_FORWARD'
  | 'WAIT_TIMEOUT'
  | 'OPERATION_ABORTED'
  | 'STALE_SNAPSHOT'
  | 'COORDINATE_OUT_OF_BOUNDS'
  | 'PAGE_NOT_READY'
  | 'LOCAL_FILE_PAGE'
  | 'STALE_ELEMENT'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'UNSUPPORTED_ELEMENT'
  | 'DIALOG_OPEN'
  | 'DIALOG_NOT_FOUND'
  | 'WAITING_FOR_USER'
  | 'ACTION_UNDETERMINED'
  | 'INTERNAL_ERROR';

const ClickCandidate = Type.Object({
  ref: Type.Optional(Id), tagName: Type.String(), role: Type.String(), name: Type.String(),
  id: Type.Optional(Type.String()), classes: Type.Array(Type.String()), clickable: Type.Boolean(), disabled: Type.Boolean(),
  evidence: Type.Enum(['native', 'role', 'handler', 'pointer', 'none']),
  bounds: Type.Object({ ...Point.properties, width: Type.Number(), height: Type.Number() }),
});
const ClickFeedback = Type.Object({
  outcome: Type.Enum(['clicked', 'no_target']), target: Type.Optional(ClickCandidate), nearby: Type.Array(ClickCandidate),
  elementsSnapshotId: Type.String(), radius: Type.Number(), coordinateSpace: Type.Literal('image'),
  truncated: Type.Boolean(), needsVisualConfirmation: Type.Boolean(), message: Type.String(),
});
export type BrowserClickCandidate = Static<typeof ClickCandidate>;
export type BrowserClickFeedback = Static<typeof ClickFeedback>;

export interface BrowserRunResult {
  ok: boolean;
  operation: BrowserOperation;
  click?: BrowserClickFeedback;
  history?: Array<Omit<BrowserHistoryEntry, 'favicon'>>;
  downloads?: BrowserDownloadEntry[];
  deviceProfiles?: Array<{ profileId: string; width: number; height: number; deviceScaleFactor: number; mobile: boolean; touch: boolean; orientation: 'portrait' | 'landscape' }>;
  browser?: BrowserSnapshot;
  tab?: BrowserTabSnapshot;
  visual?: BrowserVisualSnapshot;
  crop?: BrowserVisualCrop;
  elements?: BrowserElementsSnapshot;
  text?: BrowserTextSnapshot;
  wait?: BrowserWaitResult;
  search?: { engine: BrowserSearchEngine };
  pendingDialogs?: BrowserPendingDialog[];
  handledDialogs?: BrowserDialogRecord[];
  dialog?: { dialogId: string; kind: BrowserPageDialogKind; outcome: 'accepted' | 'dismissed' };
  notices?: string[];
  error?: {
    code: BrowserErrorCode;
    message: string;
    lastObserved?: BrowserWaitEvidence;
  };
  receipt?: string;
}

export { isBrowserUiRequest, isBrowserUiState, isBrowserUiResponse, type BrowserUiTab, type BrowserUiState, type BrowserUiCommand, type BrowserUiRequest, type BrowserUiCommandRequest, type BrowserUiResponse } from './browser-automation-ui';
