import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { build } from 'tsdown';
import { Guard } from 'typebox/guard';
import { Value } from 'typebox/value';
import { schemas } from '../../../scripts/browser-aot-registry';
import { browserAotPlugin, browserValidatorModule } from '../../../scripts/browser-aot-plugin.mjs';
import { defineBrowserValidator } from '../../../src/shared/browser-validator';
import { Type, type TSchema } from 'typebox';

const desktop = fileURLToPath(new URL('../../..', import.meta.url));
let directory: string;
const outputs = new Map<string, string>();

type Validator = { Check: (value: unknown) => boolean; Parse: (value: unknown) => unknown };
type SampleSet = { bases: number; values: { value: unknown; expected: boolean }[] };

let compiledValidators: Record<string, Record<string, Validator>>;
const sampleSets = new Map<string, SampleSet>();
let validSamples = 0;
let invalidSamples = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'browser-aot-test-'));
  const fixture = join(directory, 'validators.ts');
  await writeFile(fixture, Object.keys(schemas).map((name, index) => `export { browserValidators as m${index} } from ${JSON.stringify(join(desktop, 'src/shared', name))};`).join('\n'));
  const entries = ['preload', 'browser-overlay-preload', 'browser-control-preload', 'validators'];
  for (const name of entries) {
    const bundles = await build({
      config: false, cwd: desktop, entry: { [name]: name === 'validators' ? fixture : join(desktop, 'src/main', name === 'preload' ? `ipc/${name}.ts` : `browser/${name}.ts`) },
      format: ['cjs'], platform: 'node', target: 'node20', outDir: directory, clean: false, dts: false,
      fixedExtension: true, outputOptions: { codeSplitting: false }, plugins: [browserAotPlugin()], logLevel: 'silent',
      deps: { alwaysBundle: [/^typebox(?:\/|$)/, /^@moonshot-ai\//], neverBundle: ['electron'], onlyBundle: false },
    });
    try { outputs.set(name, await readFile(join(directory, `${name}.cjs`), 'utf8')); }
    finally { for (const bundle of bundles) await bundle[Symbol.asyncDispose](); }
  }
  compiledValidators = execute('validators').validators;
}, 30_000);

afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function execute(name: string) {
  const exposed = new Map<string, Record<string, (...args: unknown[]) => unknown>>();
  const send = vi.fn();
  const listeners = new Map<string, (event: unknown, value: unknown) => void>();
  const module = { exports: {} };
  const require = (id: string) => {
    if (id !== 'electron') throw new Error(`Unexpected preload dependency: ${id}`);
    return {
      contextBridge: { exposeInMainWorld: (key: string, value: Record<string, (...args: unknown[]) => unknown>) => exposed.set(key, value) },
      ipcRenderer: { send, on: (key: string, cb: (event: unknown, value: unknown) => void) => listeners.set(key, cb), removeListener: vi.fn() },
      webUtils: {},
    };
  };
  runInNewContext(outputs.get(name)!, { module, exports: module.exports, require, URL, TextEncoder, TextDecoder, process: { argv: [] } }, { contextCodeGeneration: { strings: false, wasm: false } });
  return { exposed, send, listeners, validators: module.exports as Record<string, Record<string, Validator>> };
}

it('registers the download IPC validators for AOT generation', () => {
  expect(Object.keys(schemas['browser-data']!)).toEqual(expect.arrayContaining([
    'BrowserDownloadItemsSchema', 'BrowserDownloadActionSchema', 'BrowserDownloadIdSchema', 'BrowserDownloadsWatchSchema',
  ]));
  const compiled = execute('validators').validators;
  const data = Object.values(compiled).find((module) => 'BrowserDownloadsWatchSchema' in module)!;
  for (const value of [true, false, 'true', 1, null, undefined, {}]) {
    expect(data['BrowserDownloadsWatchSchema']!.Check(value)).toBe(typeof value === 'boolean');
  }
});

it('registers the page dialog IPC validators for AOT generation', () => {
  expect(Object.keys(schemas['browser-dialogs']!)).toEqual(['BrowserPageDialogsSchema', 'BrowserPageDialogAnswerSchema']);
  const compiled = execute('validators').validators;
  const dialogs = Object.values(compiled).find((module) => 'BrowserPageDialogAnswerSchema' in module)!;
  const dialog = { dialogId: 'dialog-1', browserId: 'browser-1', kind: 'file', origin: 'https://example.test', message: '', answerer: 'agent', accept: ['.pdf'], multiple: false };
  expect(dialogs['BrowserPageDialogsSchema']!.Check([dialog])).toBe(true);
  expect(dialogs['BrowserPageDialogsSchema']!.Check([{ ...dialog, kind: 'prompt', defaultValue: 'Ada' }])).toBe(true);
  expect(dialogs['BrowserPageDialogsSchema']!.Check([{ ...dialog, kind: 'popup' }])).toBe(false);
  expect(dialogs['BrowserPageDialogsSchema']!.Check([{ ...dialog, extra: true }])).toBe(false);
  expect(dialogs['BrowserPageDialogAnswerSchema']!.Check({ dialogId: 'dialog-1', accept: true })).toBe(true);
  expect(dialogs['BrowserPageDialogAnswerSchema']!.Check({ dialogId: 'dialog-1', accept: true, files: ['/etc/passwd'] })).toBe(false);
  expect(dialogs['BrowserPageDialogAnswerSchema']!.Check({ dialogId: 'dialog-1', accept: true, text: 'Grace' })).toBe(true);
  expect(dialogs['BrowserPageDialogAnswerSchema']!.Check({ dialogId: 'dialog-1', accept: true, text: 'x'.repeat(10_001) })).toBe(false);
});

it('registers the control surface dialog history and download action validators for AOT generation', () => {
  expect(Object.keys(schemas['browser-control']!)).toEqual(expect.arrayContaining(['dialogs', 'downloadAction']));
  const compiled = execute('validators').validators;
  const control = Object.values(compiled).find((module) => 'downloadAction' in module && 'takeover' in module)!;
  const record = { id: 'record-1', kind: 'download', origin: 'https://example.test', outcome: 'saved', answerer: 'auto', openedAt: 1, settledAt: 2, files: ['/d/a.dmg'], downloadId: 'download-1' };
  expect(control['dialogs']!.Check({ browserId: 'page', revision: 1, records: [record] })).toBe(true);
  expect(control['dialogs']!.Check({ browserId: 'page', revision: 1, records: [{ ...record, outcome: 'exploded' }] })).toBe(false);
  expect(control['dialogs']!.Check({ browserId: 'page', revision: 1, records: [{ ...record, extra: true }] })).toBe(false);
  expect(control['downloadAction']!.Check({ browserId: 'page', revision: 1, recordId: 'record-1', action: 'move' })).toBe(true);
  expect(control['downloadAction']!.Check({ browserId: 'page', revision: 1, recordId: 'record-1', action: 'delete' })).toBe(false);
  expect(control['downloadAction']!.Check({ browserId: 'page', revision: 1, recordId: 'record-1', action: 'show', path: '/etc' })).toBe(false);
});

it('validates run identity, controller metadata and run-scoped ownership through AOT', () => {
  expect(Object.keys(schemas['browser-run']!)).toEqual(['run', 'controller']);
  const compiled = execute('validators').validators;
  const run = Object.values(compiled).find((module) => 'controller' in module && 'run' in module)!;
  const identity = { agentId: 'agent-1', generation: 2, turnId: 7 };
  expect(run['run']!.Check(identity)).toBe(true);
  expect(run['run']!.Check({ ...identity, generation: -1 })).toBe(false);
  expect(run['run']!.Check({ ...identity, extra: true })).toBe(false);
  expect(run['controller']!.Check({ run: identity, profile: 'coder', description: 'Inspect docs' })).toBe(true);
  expect(run['controller']!.Check({ run: identity, profile: 42 })).toBe(false);
  const control = Object.values(compiled).find((module) => 'BrowserControlOwnershipSchema' in module)!;
  const ownership = { sessionIds: [], runs: [{ sessionId: 'session-1', run: identity }], browserIds: ['browser-1'] };
  expect(control['BrowserControlOwnershipSchema']!.Check(ownership)).toBe(true);
  expect(control['BrowserControlOwnershipSchema']!.Check({ ...ownership, runs: [{ sessionId: 'session-1', run: { ...identity, turnId: '7' } }] })).toBe(false);
});

it('validates the agent download preferences through the AOT browser data validators', () => {
  const compiled = execute('validators').validators;
  const data = Object.values(compiled).find((module) => 'BrowserPreferencesPatchSchema' in module)!;
  expect(data['BrowserPreferencesPatchSchema']!.Check({ agentDownloadLimitBytes: 500 * 1_024 ** 2 })).toBe(true);
  expect(data['BrowserPreferencesPatchSchema']!.Check({ agentDownloadLimitBytes: null, agentDownloadDirectory: null })).toBe(true);
  expect(data['BrowserPreferencesPatchSchema']!.Check({ agentDownloadDirectory: '/etc' })).toBe(false);
  expect(data['BrowserPreferencesPatchSchema']!.Check({ agentDownloadLimitBytes: 0 })).toBe(false);
  expect(data['BrowserPreferencesPatchSchema']!.Check({ subagentControl: true })).toBe(true);
  expect(data['BrowserPreferencesPatchSchema']!.Check({ subagentControl: 'yes' })).toBe(false);
  expect(data['BrowserPreferencesPatchSchema']!.Check({ autoplay: 'allow' })).toBe(true);
  expect(data['BrowserPreferencesPatchSchema']!.Check({ autoplay: 'https://example.test/media' })).toBe(false);
  expect(data['BrowserPreferencesPatchSchema']!.Check({ agentLocalFiles: true })).toBe(true);
  expect(data['BrowserPreferencesPatchSchema']!.Check({ agentLocalFiles: 'yes' })).toBe(false);
  const snapshot = { history: [], preferences: { agentControl: true, subagentControl: false, agentLocalFiles: false, searchEngine: 'google', askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, customUserAgent: null, userAgentPresets: [], agentDownloadDirectory: '/Volumes/a', agentDownloadLimitBytes: null }, defaultUserAgent: 'Mozilla/5.0', agentDownloads: { path: '/Volumes/a', custom: true, fallback: false, access: 'unknown' } };
  expect(data['BrowserDataSnapshotSchema']!.Check(snapshot)).toBe(true);
  expect(data['BrowserDataSnapshotSchema']!.Check({ ...snapshot, agentDownloads: { ...snapshot.agentDownloads, access: 'maybe' } })).toBe(false);
});

it('bundles every preload without the schema builder, interpreter or runtime compiler', () => {
  const limits = { preload: 156_000, 'browser-overlay-preload': 50_000, 'browser-control-preload': 22_000 };
  for (const [name, limit] of Object.entries(limits)) {
    const code = outputs.get(name)!;
    expect(code).not.toMatch(/typebox\/build\/(?:type|value|compile|schema)\//);
    expect(Buffer.byteLength(code), name).toBeLessThan(limit);
    expect(execute(name).exposed.size).toBe(1);
  }
});

it('preserves interpreter checks and field projection across registered validators', () => {
  const compiled = execute('validators').validators;
  const values: unknown[] = [null, undefined, [], {}, true, false, 0, -1, Infinity, NaN, '', 'browser-1', 'x'.repeat(129), '😀'.repeat(129),
    { enabled: false, width: 400 },
    { sourceId: 'browser-a', targetId: 'browser-b', extra: true },
    { sourceId: 'browser-a', targetId: 42 },
    { browserId: 'browser-a', address: 'example.com', extra: true },
    { browserId: 'browser-a', address: 42 },
    { browserId: 'browser-a', enabled: true, extra: true },
    { browserId: 'browser-a', enabled: 'true' },
    { requestId: 1, action: 'confirm', value: '', checked: false, extra: true },
    { browserId: 'browser-1', text: 'Find', forward: true, findNext: false, extra: true },
    { x: 1.4, y: 2.6, width: 200, height: 100, extra: true },
    { menuId: 'menu', anchor: { x: 0, y: 0, width: 28, height: 28 }, items: [{ kind: 'item', id: 'open', label: 'Open' }] },
    { menuId: 'menu', anchor: { x: 0, y: 0, width: 28, height: 28 }, items: [{ kind: 'item', id: 'copy', label: 'Copy', keepOpen: true }] },
    [{ sessionId: 'session-1', tabs: [{ browserId: 'browser-a', title: 'Page', extra: true }], activeBrowserId: 'browser-a', visible: true, extra: true }],
    [{ sessionId: 'session-1', tabs: [{ browserId: 'browser-a', title: 'x'.repeat(513) }], activeBrowserId: null, visible: true }],
    [{ sessionId: 'session-1', tabs: [], activeBrowserId: null, visible: 'yes' }],
    { id: 'download-1', action: 'pause' }, { id: 'download-1', action: 'resume' }, { id: 'download-1', action: 'cancel' }, { id: 'download-1', action: 'retry' }, { id: 'download-1', action: 'stop' },
    [{ id: 'download-1', url: 'https://e.com/a', filename: 'a', state: 'progressing', startedAt: 1, receivedBytes: 1, totalBytes: 2, active: true, speed: 512 }],
    [{ id: 'download-1', url: 'https://e.com/a', filename: 'a', state: 'interrupted', startedAt: 1, receivedBytes: 1, totalBytes: 2, active: true, resumable: true }],
    [{ id: 'download-1', url: 'https://e.com/a', filename: 'a', state: 'progressing', startedAt: 1, receivedBytes: 1, totalBytes: 2, speed: NaN, resumable: 1 }],
  ];
  for (const [index, entries] of Object.values(schemas).entries()) for (const [key, schema] of Object.entries(entries)) {
    const original = defineBrowserValidator(schema);
    const generated = compiled[`m${index}`]![key]!;
    const candidates = [...values];
    try { candidates.push(Value.Create(schema)); } catch {}
    for (const value of candidates) {
      expect(generated.Check(value), key).toBe(original.Check(value));
      expect(generated.Parse(value), key).toEqual(original.Parse(value));
    }
  }
});

type SchemaNode = { [key: string]: unknown };

const junk: unknown[] = [null, undefined, '', 'a', 'browser-1', 'x'.repeat(600), '😀'.repeat(129), 0, -1, 1.5, 2 ** 53, NaN, Infinity, true, {}, [], [null]];

function stringSamples(schema: SchemaNode): string[] {
  const min = typeof schema['minLength'] === 'number' ? schema['minLength'] : 0;
  return ['a', 'en-US', 'browser-1', 'Session_1:2.x', 'r-0123456789ab', 'data:image/png;base64,AAAA', 'https://example.com/path?q=1', 'file:///tmp/a.txt', '#ffffff', 'a'.repeat(Math.max(min, 1)), ''];
}

function numberSamples(schema: SchemaNode): number[] {
  const bounds = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].map(key => schema[key]).filter((value): value is number => typeof value === 'number');
  return [...bounds, ...bounds.map(value => value + 1), ...bounds.map(value => value - 1), ...bounds.map(value => value + 0.5), 0, 1, 2, 100];
}

function samples(schema: unknown, depth = 0): unknown[] {
  if (typeof schema !== 'object' || schema === null || depth > 12) return [];
  const node = schema as SchemaNode;
  const accept = (values: unknown[]) => values.filter(value => Value.Check(node as never, value)).slice(0, 6);
  if ('const' in node) return [node['const']];
  if (Array.isArray(node['enum'])) return node['enum'];
  if (Array.isArray(node['anyOf'])) return accept(node['anyOf'].flatMap(branch => samples(branch, depth + 1)));
  const types = Array.isArray(node['type']) ? node['type'] : [node['type']];
  const values: unknown[] = [];
  for (const type of types) {
    if (type === 'string') values.push(...stringSamples(node));
    else if (type === 'number' || type === 'integer') values.push(...numberSamples(node));
    else if (type === 'boolean') values.push(true, false);
    else if (type === 'null') values.push(null);
    else if (type === 'array') {
      const items = node['prefixItems'] ?? node['items'];
      if (Array.isArray(items)) {
        values.push(items.map(item => samples(item, depth + 1)[0]));
      } else {
        const count = Math.max(typeof node['minItems'] === 'number' ? node['minItems'] : 1, 1);
        values.push([], ...samples(items, depth + 1).map(value => Array.from({ length: count }, () => value)));
      }
    } else if (type === 'object') {
      const required = new Set(Array.isArray(node['required']) ? node['required'] : []);
      const options = Object.entries((node['properties'] ?? {}) as Record<string, unknown>).map(([key, value]) => [key, samples(value, depth + 1)] as const);
      const full = Object.fromEntries(options.filter(([, list]) => list.length > 0).map(([key, list]) => [key, list[0]]));
      values.push(full, Object.fromEntries(Object.entries(full).filter(([key]) => required.has(key))));
      for (const [key, list] of options) for (const option of list.slice(1)) values.push({ ...full, [key]: option });
    } else if (type === undefined && !('not' in node)) values.push('anything', 1, {});
  }
  return accept(values);
}

function mutations(value: unknown, depth = 0): unknown[] {
  const variants: unknown[] = [...junk];
  if (depth > 6 || typeof value !== 'object' || value === null) return variants;
  if (Array.isArray(value)) {
    variants.push([...value, value[0]], value.slice(1));
    value.forEach((item, index) => {
      for (const next of mutations(item, depth + 1)) variants.push(value.map((entry, position) => position === index ? next : entry));
    });
    return variants;
  }
  const record = value as Record<string, unknown>;
  variants.push({ ...record, extra: true });
  for (const key of Object.keys(record)) {
    variants.push(Object.fromEntries(Object.entries(record).filter(([name]) => name !== key)));
    for (const next of mutations(record[key], depth + 1)) variants.push({ ...record, [key]: next });
  }
  return variants;
}

function same(left: unknown, right: unknown): boolean {
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return Object.is(left, right);
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

beforeAll(() => {
  for (const [name, entries] of Object.entries(schemas)) for (const [key, schema] of Object.entries(entries)) {
    const bases = samples(schema);
    const values = [...bases, ...bases.flatMap(base => mutations(base))].map(value => ({ value, expected: Value.Check(schema, value) }));
    for (const { expected } of values) {
      if (expected) validSamples += 1;
      else invalidSamples += 1;
    }
    sampleSets.set(`${name}.${key}`, { bases: bases.length, values });
  }
}, 30_000);

for (const [index, [name, entries]] of Object.entries(schemas).entries()) for (const [key, schema] of Object.entries(entries)) {
  it(`matches the interpreter on generated valid and invalid samples for ${name}.${key}`, () => {
    const original = defineBrowserValidator(schema);
    const generated = compiledValidators[`m${index}`]![key]!;
    const sampleSet = sampleSets.get(`${name}.${key}`)!;
    expect(sampleSet.bases, key).toBeGreaterThan(0);
    const mismatches: string[] = [];
    for (const { value, expected } of sampleSet.values) {
      if (generated.Check(value) !== expected || !same(generated.Parse(value), original.Parse(value))) mismatches.push(`${key}: ${JSON.stringify(value)}`);
    }
    expect(mismatches).toEqual([]);
  });
}

it('generates broad valid and invalid sample coverage', () => {
  expect(validSamples).toBeGreaterThan(5_000);
  expect(invalidSamples).toBeGreaterThan(40_000);
});

it('compiles identical sub-schemas and patterns once without changing their checks', () => {
  const id = () => Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9:_-]+$' });
  const rect = () => Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number({ minimum: 0 }), height: Type.Number({ minimum: 0 }) });
  const item = () => Type.Object({ id: id(), label: Type.String({ maxLength: 200 }), rect: Type.Optional(rect()) });
  const tops: TSchema[] = [
    Type.Object({ browserId: id(), items: Type.Array(item(), { maxItems: 4 }), anchor: rect() }),
    Type.Object({ sessionId: Type.Optional(id()), menu: Type.Array(item()), nested: Type.Array(Type.Array(item())) }),
    Type.Union([rect(), Type.Null()]),
    Type.Object({ value: Type.String({ pattern: '^[A-Za-z0-9:_-]+$' }), other: Type.Optional(Type.String({ pattern: '^[a-z]+$' })) }),
    item(),
    Type.Cyclic({ Node: Type.Object({ id: id(), children: Type.Array(Type.Ref('Node'), { maxItems: 4 }) }) }, 'Node'),
  ];
  const trees = [{ id: 'a', children: [] }, { id: 'a', children: [{ id: 'b', children: [{ id: 'c', children: [] }] }] }];
  const code = browserValidatorModule(tops);
  expect(code.match(/new RegExp\("\^\[A-Za-z0-9:_-\]\+\$"/g)).toHaveLength(1);
  expect(code.match(/"width" in value/g)).toHaveLength(1);
  expect(code.match(/"label" in value/g)).toHaveLength(1);
  expect(code).not.toMatch(/External/);
  expect(code).toMatch(/const schema5_check_\d+ =/);
  const module = { exports: {} as Record<string, Validator> };
  const script = code
    .replace(/^import \{ Guard \} from "typebox\/guard";$/m, '')
    .replace(/^export const (v\d+) =/gm, 'module.exports.$1 =');
  runInNewContext(script, { module, Guard }, { contextCodeGeneration: { strings: false, wasm: false } });
  for (const [index, schema] of tops.entries()) {
    const generated = module.exports[`v${index}`]!;
    const original = defineBrowserValidator(schema);
    const bases = index === 5 ? trees : samples(schema);
    expect(bases.every(base => Value.Check(schema, base))).toBe(true);
    expect(bases.length).toBeGreaterThan(0);
    for (const value of [...bases, ...bases.flatMap(base => mutations(base))]) {
      expect(generated.Check(value)).toBe(Value.Check(schema, value));
      expect(same(generated.Parse(value), original.Parse(value))).toBe(true);
    }
  }
});

it('rejects missing control leases and malformed control pushes in the built bridges', () => {
  const main = execute('preload');
  const bridge = main.exposed.get('kimiDesktop')!;
  const state = { turnId: null, panelVisible: false, activeTabId: null, controlledTabId: 'tab-1', controlledLeaseId: 'lease-1', tabs: [{ tabId: 'tab-1', browserId: 'browser-1' }] };
  bridge['browserAutomationUiRespond']!({ requestId: 1, ok: true, state });
  bridge['browserAutomationUiRespond']!({ requestId: 2, ok: true, state: { ...state, controlledLeaseId: undefined } });
  expect(main.send).toHaveBeenCalledOnce();
  const onRequest = vi.fn();
  bridge['onBrowserAutomationUiRequest']!(onRequest);
  const request = {
    requestId: 3,
    controller: { run: { agentId: 'agent-1', generation: 2, turnId: 7 } },
    command: { action: 'close_tab', tabId: 'tab-1', expectedLeaseId: 'lease-1' },
  };
  main.listeners.get('kimi:browser-automation-ui-request')!({}, request);
  main.listeners.get('kimi:browser-automation-ui-request')!({}, { requestId: 4, command: { action: 'close_tab', tabId: 'tab-1' } });
  expect(onRequest).toHaveBeenCalledExactlyOnceWith(request);
  const control = execute('browser-control-preload');
  const pointer = vi.fn();
  control.exposed.get('kimiBrowserControl')!['onPointer']!(pointer);
  const payload = { browserId: 'browser-1', revision: 1, kind: 'move', x: 10, y: 20 };
  control.listeners.get('kimi:browser-control-pointer')!({}, payload);
  control.listeners.get('kimi:browser-control-pointer')!({}, { ...payload, x: NaN });
  expect(pointer).toHaveBeenCalledExactlyOnceWith(payload);
});

it('keeps overlay normalization and rejects invalid geometry in the built bridge', () => {
  const overlay = execute('browser-overlay-preload');
  const bridge = overlay.exposed.get('kimiBrowserOverlay')!;
  bridge['rendered']!({ requestId: 1, width: 200.2, height: 100.1, ignored: true });
  bridge['rendered']!({ requestId: 1, width: -1, height: 100 });
  bridge['submitForm']!({ requestId: 2, action: 'confirm', value: '', checked: false, ignored: true });
  expect(overlay.send.mock.calls).toEqual([
    ['kimi:browser-overlay-rendered', { requestId: 1, width: 201, height: 101 }],
    ['kimi:browser-overlay-form-action', { requestId: 2, action: 'confirm', value: '', checked: false }],
  ]);
});

it('fails generation for nonserializable external checks', () => {
  expect(() => browserValidatorModule([Type.Refine(Type.String(), value => value.startsWith('allowed'))])).toThrow();
});
