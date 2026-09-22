import { open, stat } from 'node:fs/promises';

export interface ContextRecord {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface WireRecordCacheOptions {
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const EMPTY_BUFFER = Buffer.alloc(0);

interface WireCacheEntry {
  offset: number;
  size: number;
  mtimeMs: number;
  ino: number;
  lineCount: number;
  records: ContextRecord[];
  tail: Buffer;
  chain: Promise<void>;
}

export class WireRecordCache {
  private readonly entries = new Map<string, WireCacheEntry>();
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;

  constructor(options: WireRecordCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  get size(): number {
    return this.entries.size;
  }

  read(wirePath: string): Promise<ContextRecord[]> {
    let entry = this.entries.get(wirePath);
    if (entry === undefined) {
      entry = {
        offset: 0,
        size: 0,
        mtimeMs: 0,
        ino: 0,
        lineCount: 0,
        records: [],
        tail: EMPTY_BUFFER,
        chain: Promise.resolve(),
      };
    } else {
      this.entries.delete(wirePath);
    }
    this.entries.set(wirePath, entry);
    const run = entry.chain.then(() => this.sync(wirePath, entry));
    entry.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async sync(wirePath: string, entry: WireCacheEntry): Promise<ContextRecord[]> {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(wirePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.evict(wirePath, entry);
      throw error;
    }
    const replaced = entry.ino !== 0 && st.ino !== entry.ino;
    const shrank = st.size < entry.size;
    const rewrittenInPlace =
      entry.ino !== 0 && st.size === entry.size && st.mtimeMs !== entry.mtimeMs;
    if (replaced || shrank || rewrittenInPlace) {
      entry.offset = 0;
      entry.size = 0;
      entry.lineCount = 0;
      entry.records = [];
      entry.tail = EMPTY_BUFFER;
    }
    if (st.size > entry.size) {
      await this.readAppended(wirePath, entry, st.size);
    }
    entry.size = entry.offset + entry.tail.length;
    entry.mtimeMs = st.mtimeMs;
    entry.ino = st.ino;
    this.trimOverflow(wirePath);
    return snapshotRecords(entry);
  }

  private async readAppended(wirePath: string, entry: WireCacheEntry, size: number): Promise<void> {
    const handle = await open(wirePath, 'r');
    let region: Buffer;
    try {
      const length = size - entry.offset;
      const buf = Buffer.allocUnsafe(length);
      let position = 0;
      while (position < length) {
        const { bytesRead } = await handle.read(
          buf,
          position,
          length - position,
          entry.offset + position,
        );
        if (bytesRead === 0) break;
        position += bytesRead;
      }
      region = position === length ? buf : buf.subarray(0, position);
    } finally {
      await handle.close();
    }
    let start = 0;
    let lineCount = entry.lineCount;
    const parsed: ContextRecord[] = [];
    for (;;) {
      const nl = region.indexOf(0x0a, start);
      if (nl === -1) break;
      lineCount += 1;
      const record = parseWireLine(
        region.subarray(start, nl).toString('utf8'),
        wirePath,
        lineCount,
      );
      if (record !== undefined) parsed.push(record);
      start = nl + 1;
    }
    for (const record of parsed) entry.records.push(record);
    entry.lineCount = lineCount;
    entry.offset += start;
    entry.tail = start === region.length ? EMPTY_BUFFER : Buffer.from(region.subarray(start));
  }

  private evict(wirePath: string, entry: WireCacheEntry): void {
    if (this.entries.get(wirePath) === entry) this.entries.delete(wirePath);
  }

  private trimOverflow(keepPath: string): void {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.size;
    for (const [path, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && total <= this.maxTotalBytes) return;
      if (path === keepPath) continue;
      this.entries.delete(path);
      total -= entry.size;
    }
  }
}

function parseWireLine(
  line: string,
  wirePath: string,
  lineNumber: number,
): ContextRecord | undefined {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as ContextRecord;
  } catch (parseError) {
    throw new Error(
      `wire.jsonl: corrupted line ${lineNumber} in ${wirePath}: ${String(parseError)}`,
      { cause: parseError },
    );
  }
}

function snapshotRecords(entry: WireCacheEntry): ContextRecord[] {
  const records = [...entry.records];
  if (entry.tail.length === 0) return records;
  const text = entry.tail.toString('utf8');
  const line = text.endsWith('\r') ? text.slice(0, -1) : text;
  if (line.length === 0) return records;
  try {
    records.push(JSON.parse(line) as ContextRecord);
  } catch {}
  return records;
}
