import { HistoryHeights } from './heights';

export type RowRevision = string | number;

export interface RowMeasurement {
  height: number;
  width: number;
  fontScale: string;
  rev: RowRevision;
}

export interface RowRecord {
  measured?: RowMeasurement;
  estimate: number;
}

export interface LayoutRow {
  key: string;
  estimate: number;
  kind?: string;
  rev?: RowRevision;
}

export interface LayoutEnvironment {
  width: number;
  fontScale: string;
}

export interface RenderRangeOptions {
  overscanPx?: number;
  tail?: number;
  protected?: ReadonlySet<string>;
  renderAll?: boolean;
}

export interface RenderedRow {
  index: number;
  key: string;
  spaceBefore: number;
}

export interface RenderRange {
  rows: RenderedRow[];
  spaceAfter: number;
}

export const ROW_CACHE_LIMIT = 5000;
export const MIN_ROW_HEIGHT = 1;

export class RowHeightCache {
  private readonly records = new Map<string, RowRecord>();

  constructor(readonly limit = ROW_CACHE_LIMIT) {}

  get size(): number {
    return this.records.size;
  }

  get(key: string): RowRecord | undefined {
    const record = this.records.get(key);
    if (record) {
      this.records.delete(key);
      this.records.set(key, record);
    }
    return record;
  }

  set(key: string, record: RowRecord): void {
    this.records.delete(key);
    this.records.set(key, record);
    while (this.records.size > this.limit) this.records.delete(this.records.keys().next().value!);
  }

  delete(key: string): void {
    this.records.delete(key);
  }

  clear(): void {
    this.records.clear();
  }
}

export const sharedRowHeightCache = new RowHeightCache();

export interface LayoutModelOptions {
  scope: string;
  cache?: RowHeightCache;
  environment?: Partial<LayoutEnvironment>;
}

type RowMeta = { kind: string; rev: RowRevision };
type Learned = { sum: number; count: number };
type Contribution = { bucket: string; ratio: number };

export class LayoutModel {
  private scopeKey: string;
  private readonly cache: RowHeightCache;
  private env: LayoutEnvironment;
  private keys: string[] = [];
  private meta: RowMeta[] = [];
  private records: RowRecord[] = [];
  private readonly positions = new Map<string, number>();
  private readonly heights = new HistoryHeights();
  private readonly learned = new Map<string, Learned>();
  private readonly contributions = new Map<string, Contribution>();
  private learnedDirty = false;

  constructor(options: LayoutModelOptions) {
    this.scopeKey = options.scope;
    this.cache = options.cache ?? sharedRowHeightCache;
    this.env = { width: Math.round(options.environment?.width ?? 0), fontScale: options.environment?.fontScale ?? 'medium' };
  }

  get scope(): string {
    return this.scopeKey;
  }

  get length(): number {
    return this.keys.length;
  }

  get environment(): Readonly<LayoutEnvironment> {
    return this.env;
  }

  setScope(scope: string): void {
    if (scope === this.scopeKey) return;
    this.scopeKey = scope;
    this.learned.clear();
    this.contributions.clear();
    this.learnedDirty = false;
    this.setRows([]);
  }

  setRows(rows: readonly LayoutRow[]): void {
    this.positions.clear();
    this.keys = [];
    this.meta = [];
    this.records = [];
    rows.forEach((row, index) => {
      this.positions.set(row.key, index);
      this.keys.push(row.key);
      this.meta.push({ kind: row.kind ?? 'row', rev: row.rev ?? 0 });
      const cacheKey = this.cacheKey(row.key);
      const record = this.cache.get(cacheKey) ?? { estimate: row.estimate };
      record.estimate = row.estimate;
      this.cache.set(cacheKey, record);
      this.records.push(record);
    });
    for (const key of this.contributions.keys()) if (!this.positions.has(key)) this.dropContribution(key);
    this.learnedDirty = false;
    this.rebuild();
  }

  setEnvironment(environment: Partial<LayoutEnvironment>): boolean {
    const width = environment.width === undefined ? this.env.width : Math.round(environment.width);
    const fontScale = environment.fontScale ?? this.env.fontScale;
    if (width === this.env.width && fontScale === this.env.fontScale) return false;
    this.env = { width, fontScale };
    this.learnedDirty = false;
    this.rebuild();
    return true;
  }

  measure(key: string, height: number): boolean {
    const index = this.positions.get(key);
    const cacheKey = this.cacheKey(key);
    const record = index === undefined ? this.cache.get(cacheKey) ?? { estimate: height } : this.records[index]!;
    if (index === undefined) this.cache.set(cacheKey, record);
    const rev = index === undefined ? record.measured?.rev ?? 0 : this.meta[index]!.rev;
    const previous = index === undefined ? undefined : this.heights.get(index);
    record.measured = { height, width: this.env.width, fontScale: this.env.fontScale, rev };
    if (index === undefined) return false;
    this.learn(key, this.meta[index]!.kind, record);
    if (previous === height) return false;
    this.heights.set(index, height);
    return true;
  }

  refreshEstimates(): boolean {
    if (!this.learnedDirty) return false;
    this.learnedDirty = false;
    let changed = false;
    for (let i = 0; i < this.keys.length; i++) {
      const height = this.effective(i);
      if (height !== this.heights.get(i)) {
        this.heights.set(i, height);
        changed = true;
      }
    }
    return changed;
  }

  record(key: string): Readonly<RowRecord> | undefined {
    const index = this.positions.get(key);
    return index === undefined ? this.cache.get(this.cacheKey(key)) : this.records[index];
  }

  isMeasured(key: string): boolean {
    const index = this.positions.get(key);
    if (index === undefined) return false;
    const measured = this.records[index]!.measured;
    return measured !== undefined && this.fresh(measured, this.meta[index]!.rev);
  }

  indexOf(key: string): number | undefined {
    return this.positions.get(key);
  }

  keyAt(index: number): string | undefined {
    return this.keys[index];
  }

  height(index: number): number {
    return this.heights.get(index);
  }

  top(index: number): number {
    return this.heights.top(Math.max(0, Math.min(index, this.keys.length)));
  }

  indexAt(offset: number): number {
    return this.heights.at(offset);
  }

  total(): number {
    return this.heights.top(this.keys.length);
  }

  range(viewTop: number, viewBottom: number, options: RenderRangeOptions = {}): RenderRange {
    const n = this.keys.length;
    if (!n) return { rows: [], spaceAfter: 0 };
    const chosen = new Set<number>();
    if (options.renderAll) {
      for (let i = 0; i < n; i++) chosen.add(i);
    } else {
      const overscan = Math.max(0, options.overscanPx ?? 0);
      const total = this.total();
      const from = viewTop - overscan;
      const to = viewBottom + overscan;
      if (to >= 0 && from <= total) {
        const first = this.indexAt(Math.max(0, from));
        const last = this.indexAt(Math.max(0, Math.min(to, total)));
        for (let i = first; i <= last; i++) chosen.add(i);
      }
      for (let i = Math.max(0, n - Math.max(0, options.tail ?? 0)); i < n; i++) chosen.add(i);
      for (const key of options.protected ?? []) {
        const index = this.positions.get(key);
        if (index !== undefined) chosen.add(index);
      }
    }
    const rows: RenderedRow[] = [];
    let end = 0;
    for (const index of [...chosen].sort((a, b) => a - b)) {
      rows.push({ index, key: this.keys[index]!, spaceBefore: this.top(index) - this.top(end) });
      end = index + 1;
    }
    return { rows, spaceAfter: this.total() - this.top(end) };
  }

  private cacheKey(key: string): string {
    return `${this.scopeKey}:${key}`;
  }

  private bucket(kind: string): string {
    return `${kind}\u0000${this.env.width}\u0000${this.env.fontScale}`;
  }

  private fresh(measured: RowMeasurement, rev: RowRevision): boolean {
    return measured.width === this.env.width && measured.fontScale === this.env.fontScale && measured.rev === rev;
  }

  private effective(index: number): number {
    const record = this.records[index]!;
    if (record.measured) return record.measured.height;
    const learned = this.learned.get(this.bucket(this.meta[index]!.kind));
    const base = Math.max(MIN_ROW_HEIGHT, record.estimate);
    if (learned && learned.count > 0) return Math.max(MIN_ROW_HEIGHT, base * (learned.sum / learned.count));
    return base;
  }

  private learn(key: string, kind: string, record: RowRecord): void {
    if (!(record.estimate > 0) || !record.measured) return;
    const bucket = this.bucket(kind);
    const ratio = record.measured.height / record.estimate;
    const previous = this.contributions.get(key);
    if (previous?.bucket !== bucket) this.learnedDirty = true;
    this.dropContribution(key);
    const learned = this.learned.get(bucket) ?? { sum: 0, count: 0 };
    learned.sum += ratio;
    learned.count++;
    this.learned.set(bucket, learned);
    this.contributions.set(key, { bucket, ratio });
  }

  private dropContribution(key: string): void {
    const previous = this.contributions.get(key);
    if (!previous) return;
    this.contributions.delete(key);
    const learned = this.learned.get(previous.bucket);
    if (!learned) return;
    learned.sum -= previous.ratio;
    learned.count--;
    if (learned.count <= 0) this.learned.delete(previous.bucket);
  }

  private rebuild(): void {
    this.heights.reset(this.keys.map((_, index) => this.effective(index)));
  }
}
