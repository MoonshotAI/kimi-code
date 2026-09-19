import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';

import type { Entry, Journal } from './store';
import type { ILogService } from '#/_base/log/log';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { NodeBackend } from '#human/store/node';
import { journalFromBranch } from '#human/store/log';
import {
  TreeStore,
  encodeHeader,
  isOffloadedPayload,
  parseHeader,
  parseLine,
  readBlob,
  type Branch,
  type BranchHeader,
} from '#human/store/storage';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { WIRE_MIN_READER_VERSION, WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import type { SwitchedBranch } from '#/wire/journal';
import { AGENT_WIRE_RECORD_KEY, isWireRecord, type WireRecord } from '#/wire/record';
import { branchForLine, parseTree, restorableChain, type WireLine } from '#/wire/tree/index';
import { WireService } from '#/wire/wireService';

export type RecordEvent = WireRecord;

declare const cursorBrand: unique symbol;
export type Cursor = string & { readonly [cursorBrand]: true };

type RecordEntry = Entry<RecordEvent, Cursor>;
type Position =
  | { format: 'wire'; file: string; line: number }
  | { format: 'tree'; directory: string; tree: string; branch: string; seq: number };

export interface WireJournal extends Journal<RecordEvent, Cursor> {
  readonly format: 'wire';
  readonly directory: string;
  readonly file: string;
  readonly files: readonly string[];
  undo(turns: number): Promise<SwitchedBranch>;
  activeHistory(entries: readonly RecordEntry[]): readonly RecordEntry[];
  readRawRecords(): Promise<readonly RecordEvent[]>;
  readRestorableRecords(): Promise<readonly RecordEvent[]>;
}

export interface TreeJournal extends Journal<RecordEvent, Cursor> {
  readonly format: 'tree';
  readonly directory: string;
  readonly tree: string;
  readonly branch: string;
  readonly files: readonly string[];
  readonly blobsDirectory: string;
  branchPath(branch?: string): string;
  branches(): readonly string[];
  fork(branchName: string, cursor: Cursor): Promise<void>;
  checkout(branchName: string): Promise<void>;
}

const payloadKind = 'event';
const branchPattern = /^[A-Za-z0-9_][A-Za-z0-9._~-]*$/;

class Operations {
  private tail: Promise<void> = Promise.resolve();
  private failure: { error: unknown } | undefined;
  private closing: Promise<void> | undefined;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing !== undefined) return Promise.reject(new Error('Journal is closed'));
    const result = this.tail.then(() => {
      if (this.failure !== undefined) throw this.failure.error;
      return operation();
    });
    this.tail = result.then(
      () => undefined,
      (error: unknown) => { this.failure ??= { error }; },
    );
    return result;
  }

  close(cleanup: () => Promise<void>): Promise<void> {
    this.closing ??= this.tail.then(async () => {
      const errors: unknown[] = this.failure === undefined ? [] : [this.failure.error];
      try {
        await cleanup();
      } catch (error) {
        if (!errors.includes(error)) errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Journal close failed');
    });
    return this.closing;
  }
}

function assertRecord(value: unknown): asserts value is RecordEvent {
  if (!isWireRecord(value) || value.type.length === 0) throw new Error('Expected a record with a nonempty type');
  if (value.time !== undefined && (typeof value.time !== 'number' || !Number.isFinite(value.time))) {
    throw new Error('Record time must be a finite number');
  }
}

function inspectJson(value: unknown, freeze: boolean, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw new Error('Records must contain acyclic JSON values');
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('Records must contain only plain objects and arrays');
  }
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) inspectJson(item, freeze, ancestors);
  ancestors.delete(value);
  if (freeze) Object.freeze(value);
}

function snapshot(value: unknown): RecordEvent {
  assertRecord(value);
  inspectJson(value, false);
  const record: unknown = JSON.parse(JSON.stringify(value));
  assertRecord(record);
  inspectJson(record, true);
  return record;
}

function cursor(position: Position): Cursor {
  return JSON.stringify(position) as Cursor;
}

function position(value: Cursor): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid cursor');
  return parsed as Record<string, unknown>;
}

function wireLine(value: Cursor, file: string): number {
  const parsed = position(value);
  const line = parsed['line'];
  if (parsed['format'] !== 'wire' || parsed['file'] !== file || typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) {
    throw new Error('Cursor does not identify a physical line in this wire journal');
  }
  return line;
}

function treePosition(value: Cursor, directory: string, tree: string): { branch: string; seq: number } {
  const parsed = position(value);
  const branch = parsed['branch'];
  const seq = parsed['seq'];
  if (parsed['format'] !== 'tree' || parsed['directory'] !== directory || parsed['tree'] !== tree || typeof branch !== 'string' || !branchPattern.test(branch) || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    throw new Error('Cursor does not identify a branch-local entry in this tree');
  }
  return { branch, seq };
}

async function plainPath(path: string, kind: 'file' | 'directory'): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Expected a non-symlink ${kind}: ${path}`);
    }
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureDirectory(dir: string): Promise<string> {
  const directory = resolve(dir);
  const { root } = parse(directory);
  let current = root;
  for (const segment of directory.slice(root.length).split(sep).filter((part) => part.length > 0)) {
    current = join(current, segment);
    if (!(await plainPath(current, 'directory'))) await mkdir(current);
  }
  return directory;
}

function physicalLines(text: string, file: string): string[] {
  if (text.length === 0 || !text.endsWith('\n')) throw new Error(`Noncanonical or truncated journal: ${file}`);
  const lines = text.slice(0, -1).split('\n');
  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0 || JSON.stringify(JSON.parse(raw)) !== raw) {
      throw new Error(`Noncanonical JSON at ${file}:${index + 1}`);
    }
  }
  return lines;
}

function assertWireEvent(record: RecordEvent): void {
  if (record.type === 'plan.revision' && typeof record['key'] !== 'string') {
    throw new Error('Legacy or malformed plan.revision records are not supported');
  }
}

function wireHistory(entries: readonly RecordEntry[], file: string): readonly RecordEntry[] {
  const lines: WireLine[] = entries.map((entry, index) => {
    const line = wireLine(entry.cursor, file);
    if (line !== index + 1) throw new Error('activeHistory requires the full contiguous raw wire ledger');
    assertRecord(entry.event);
    assertWireEvent(entry.event);
    return { line, record: entry.event };
  });
  const metadata = lines[0]?.record;
  if (metadata?.type !== 'metadata' || metadata['protocol_version'] !== WIRE_PROTOCOL_VERSION || metadata['min_protocol_version'] !== WIRE_MIN_READER_VERSION || typeof metadata['created_at'] !== 'number' || !Number.isFinite(metadata['created_at'])) {
    throw new Error('Only canonical current-version wire journals are supported');
  }
  if (lines.slice(1).some(({ record }) => record.type === 'metadata')) throw new Error('Duplicate wire metadata');
  const tree = parseTree(lines, lines.at(-1)?.line ?? 0);
  if (tree.diagnostics.malformedSwitchLines.length > 0 || tree.diagnostics.duplicateBranches.length > 0) {
    throw new Error('Malformed or ambiguous wire branch history');
  }
  for (const edge of tree.edges) {
    if (!Number.isSafeInteger(edge.base.line) || edge.base.line < 0 || edge.base.line >= edge.line || branchForLine(tree, edge.base.line) !== edge.base.branch) {
      throw new Error('Invalid wire branch base');
    }
    const switched = lines[edge.line - 1]?.record;
    const legacy = lines[edge.line]?.record;
    const undone = lines[edge.line + 1]?.record;
    const turns = switched?.['turns'];
    if (edge.branch.length === 0 || edge.legacyUndoLine !== edge.line + 1 || typeof turns !== 'number' || !Number.isSafeInteger(turns) || turns < 1 || legacy?.type !== 'context.undo' || legacy['count'] !== turns || undone?.type !== 'context.undone' || undone['turns'] !== turns) {
      throw new Error('Incomplete or noncanonical native wire switch triple');
    }
  }
  return restorableChain(lines, tree).map(({ line }) => entries[line - 1]!);
}

async function readWireFile(file: string): Promise<readonly RecordEntry[] | undefined> {
  if (!(await plainPath(file, 'file'))) return undefined;
  const entries = physicalLines(await readFile(file, 'utf8'), file).map((raw, index) => Object.freeze({
    event: snapshot(JSON.parse(raw)),
    cursor: cursor({ format: 'wire', file, line: index + 1 }),
  }));
  wireHistory(entries, file);
  return entries;
}

async function collect(records: AsyncIterable<RecordEvent>): Promise<readonly RecordEvent[]> {
  const result: RecordEvent[] = [];
  for await (const record of records) result.push(snapshot(record));
  return result;
}

function matchRecords(actual: readonly RecordEvent[], expected: readonly RecordEntry[]): void {
  if (actual.length !== expected.length || actual.some((record, index) => JSON.stringify(record) !== JSON.stringify(expected[index]!.event))) {
    throw new Error('Native wire reader changed, skipped, or ambiguously mapped physical records');
  }
}

export async function openWireJournal(dir: string, agentId = 'agent-1'): Promise<WireJournal> {
  const directory = await ensureDirectory(dir);
  const file = join(directory, AGENT_WIRE_RECORD_KEY);
  await readWireFile(file);
  const storage = new FileStorageService(directory);
  const log = new AppendLogStore(storage);
  const logger: ILogService = {
    _serviceBrand: undefined,
    level: 'off',
    setLevel: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => logger,
    flush: async () => {},
  };
  const wire = new WireService(
    makeAgentScopeContext({ agentId, agentScope: '' }),
    log,
    {
      _serviceBrand: undefined,
      offloadParts: async (parts) => parts,
      loadParts: async (parts) => parts,
      isBlobRef: () => false,
    },
    storage,
    logger,
    noopTelemetryService,
  );
  const operations = new Operations();
  const load = async (): Promise<readonly RecordEntry[]> => {
    await wire.flush();
    const entries = await readWireFile(file);
    if (entries === undefined) throw new Error('Wire journal disappeared');
    matchRecords(await collect(wire.readRaw()), entries);
    return entries;
  };
  const cleanup = async (): Promise<void> => {
    const results = await Promise.allSettled([wire.flush(), log.close()]);
    wire.dispose();
    await log.drainRetirements();
    log.dispose();
    await storage.close();
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  };
  try {
    await wire.seal();
    await load();
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
  return {
    format: 'wire',
    directory,
    file,
    files: Object.freeze([file]),
    read: () => operations.run(load),
    append: async (event) => {
      const record = snapshot(event);
      assertWireEvent(record);
      if (record.type === 'metadata' || record.type === 'agent.switched') throw new Error('Use the native driver operation for wire metadata or branch switches');
      return operations.run(async () => {
        const line = wire.nextSeq();
        wire.appendRecord(record);
        await wire.flush();
        if (wire.nextSeq() !== line + 1) throw new Error('Wire append did not advance exactly one physical line');
        return Object.freeze({ event: record, cursor: cursor({ format: 'wire', file, line }) });
      });
    },
    activeHistory: (entries) => wireHistory(entries, file),
    readRawRecords: () => operations.run(async () => (await load()).map(({ event }) => event)),
    readRestorableRecords: () => operations.run(async () => {
      const entries = await load();
      const records = await collect(wire.readRestorable());
      matchRecords(records, wireHistory(entries, file));
      return records;
    }),
    undo: async (turns) => {
      if (!Number.isSafeInteger(turns) || turns < 1) throw new Error('Undo requires a positive integer turn count');
      return operations.run(async () => {
        await load();
        const switched = await wire.switchBranch({ turns });
        await wire.flush();
        await load();
        return switched;
      });
    },
    close: () => operations.close(cleanup),
  };
}

async function validateTreeFiles(backend: NodeBackend, directory: string, treeName: string): Promise<void> {
  const treesDirectory = join(directory, 'trees');
  const blobsDirectory = join(directory, 'blobs');
  await plainPath(treesDirectory, 'directory');
  await plainPath(blobsDirectory, 'directory');
  if (await plainPath(treesDirectory, 'directory')) {
    for (const item of await readdir(treesDirectory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('Symlinked trees are not supported');
    }
  }
  for (const name of await backend.trees.list()) {
    if (name !== treeName) throw new Error(`Unexpected tree in journal directory: ${name}`);
    await plainPath(join(treesDirectory, name), 'directory');
    const headers = new Map<string, { header: BranchHeader; count: number }>();
    for (const branch of await backend.trees.listBranches(name)) {
      if (!branchPattern.test(branch)) throw new Error('Invalid branch name');
      const file = join(treesDirectory, name, `${branch}.jsonl`);
      await plainPath(file, 'file');
      const lines = physicalLines(await backend.trees.read(name, branch), file);
      const header = parseHeader(lines[0]!);
      if (!header.ok || header.value.tree !== name || header.value.branch !== branch || encodeHeader(header.value) !== `${lines[0]}\n`) {
        throw new Error(`Invalid or ambiguous branch header: ${file}`);
      }
      if ((header.value.parentBranch === undefined) !== (header.value.parentSeq === undefined)) throw new Error('Incomplete parent reference');
      for (let index = 1; index < lines.length; index++) {
        const parsed = parseLine(lines[index]!, index - 1);
        if (!parsed.ok) throw new Error(`Invalid tree entry ${file}:${index + 1}: ${parsed.error.detail}`);
        const entry = parsed.value;
        if (JSON.stringify(entry) !== lines[index] || entry.payload.kind !== payloadKind) throw new Error('Noncanonical tree entry');
        let data: unknown;
        if (isOffloadedPayload(entry.payload)) {
          if (!/^[a-f0-9]{64}$/.test(entry.payload.ref)) throw new Error('Invalid blob reference');
          await plainPath(join(blobsDirectory, entry.payload.ref), 'file');
          data = JSON.parse(await readBlob(backend.blobs, entry.payload.ref));
        } else {
          data = entry.payload.data;
        }
        assertRecord(data);
        if (data.type !== entry.type || Buffer.byteLength(JSON.stringify(data)) !== entry.payload.size) throw new Error('Tree payload does not match its entry');
      }
      headers.set(branch, { header: header.value, count: lines.length - 1 });
    }
    for (const branch of headers.keys()) {
      const visited = new Set<string>();
      let current: string | undefined = branch;
      while (current !== undefined) {
        if (visited.has(current)) throw new Error('Cyclic tree parent chain');
        visited.add(current);
        const item = headers.get(current);
        if (item === undefined) throw new Error('Missing tree parent branch');
        const parent = item.header.parentBranch;
        if (parent !== undefined) {
          const count = headers.get(parent)?.count;
          if (count === undefined || item.header.parentSeq === undefined || item.header.parentSeq >= count) throw new Error('Invalid tree parent cursor');
        }
        current = parent;
      }
    }
  }
}

export async function openTreeJournal(dir: string, treeName: string, branch = 'main'): Promise<TreeJournal> {
  if (!branchPattern.test(treeName) || !branchPattern.test(branch)) throw new Error('Invalid tree or branch name');
  const directory = await ensureDirectory(dir);
  const backend = new NodeBackend(directory);
  await validateTreeFiles(backend, directory, treeName);
  const store = await TreeStore.open(backend, { fsync: true });
  const tree = await store.tree(treeName);
  const operations = new Operations();
  const branchPath = (name = current.name): string => {
    if (!branchPattern.test(name)) throw new Error('Invalid branch name');
    return join(directory, 'trees', treeName, `${name}.jsonl`);
  };
  const checkCreated = async (created: Branch): Promise<void> => {
    await created.settled();
    if (await backend.trees.read(treeName, created.name) !== encodeHeader(created.header)) {
      throw new Error('Native branch creation did not persist the expected header');
    }
  };
  let current: Branch;
  if (tree.has(branch)) {
    current = tree.openBranch(branch);
  } else {
    if (tree.branches().length > 0) throw new Error(`Unknown branch: ${branch}`);
    current = tree.createBranch(branch);
    await checkCreated(current);
  }
  let journal = journalFromBranch(current, tree);
  return {
    format: 'tree',
    directory,
    tree: treeName,
    get branch() { return current.name; },
    get files() { return tree.branches().map((name) => branchPath(name)); },
    blobsDirectory: join(directory, 'blobs'),
    branchPath,
    branches: () => tree.branches(),
    read: () => operations.run(async () => {
      const entries: RecordEntry[] = [];
      for await (const record of journal.read()) {
        const event = snapshot(record.data);
        if (record.kind !== payloadKind || record.type !== event.type) throw new Error('Unexpected native tree journal record');
        entries.push(Object.freeze({ event, cursor: cursor({ format: 'tree', directory, tree: treeName, branch: record.branch, seq: record.seq }) }));
      }
      return entries;
    }),
    append: async (event) => {
      const record = snapshot(event);
      return operations.run(async () => {
        const entry = await journal.append({ type: record.type, kind: payloadKind, data: record });
        return Object.freeze({ event: record, cursor: cursor({ format: 'tree', directory, tree: treeName, branch: current.name, seq: entry.seq }) });
      });
    },
    fork: async (branchName, at) => {
      if (!branchPattern.test(branchName)) throw new Error('Invalid branch name');
      const from = treePosition(at, directory, treeName);
      return operations.run(async () => {
        if (tree.openBranch(from.branch).entryAt(from.seq) === null) throw new Error('Fork cursor does not identify an existing entry');
        const created = tree.createBranch(branchName, { from });
        await checkCreated(created);
        current = created;
        journal = journalFromBranch(current, tree);
      });
    },
    checkout: async (branchName) => {
      if (!branchPattern.test(branchName)) throw new Error('Invalid branch name');
      return operations.run(async () => {
        current = tree.openBranch(branchName);
        journal = journalFromBranch(current, tree);
      });
    },
    close: () => operations.close(async () => {
      await Promise.all(tree.branches().map((name) => tree.openBranch(name).settled()));
    }),
  };
}
