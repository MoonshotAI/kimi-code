import { writeBlob } from './internal/blob';
import { encodeHeader, encodeLine, parseHeader, parseLine } from './internal/codec';
import type { TreeContext } from './internal/context';
import type { AppendInput, BranchHeader, BranchRef, CorruptionKind, EntryLine, Payload } from './types';
import { StoreError } from './types';

const textEncoder = new TextEncoder();

export type BranchResolver = (name: string) => Branch | undefined;

export class Branch {
  readonly tree: string;
  readonly name: string;
  readonly header: BranchHeader;
  private readonly ctx: TreeContext;
  private readonly resolveBranch: BranchResolver;
  private readonly entries: (EntryLine | null)[];
  private degradedFlag: boolean;
  private truncateAt: number | null;
  private tail: Promise<unknown>;

  private constructor(
    ctx: TreeContext,
    header: BranchHeader,
    entries: (EntryLine | null)[],
    degraded: boolean,
    truncateAt: number | null,
    resolveBranch: BranchResolver,
  ) {
    this.ctx = ctx;
    this.header = header;
    this.tree = header.tree;
    this.name = header.branch;
    this.entries = entries;
    this.degradedFlag = degraded;
    this.truncateAt = truncateAt;
    this.resolveBranch = resolveBranch;
    this.tail = Promise.resolve();
  }

  get degraded(): boolean {
    return this.degradedFlag;
  }

  get nextSeq(): number {
    return this.entries.length;
  }

  get head(): number | null {
    return this.entries.length === 0 ? null : this.entries.length - 1;
  }

  static create(
    ctx: TreeContext,
    tree: string,
    name: string,
    resolveBranch: BranchResolver,
    from?: BranchRef,
  ): Branch {
    const header: BranchHeader = {
      version: 1,
      tree,
      branch: name,
      createdAt: Date.now(),
      parentBranch: from?.branch,
      parentSeq: from?.seq,
    };
    const branch = new Branch(ctx, header, [], false, null, resolveBranch);
    void branch
      .enqueue(() => ctx.backend.trees.write(tree, name, encodeHeader(header)))
      .catch(() => undefined);
    return branch;
  }

  static async load(
    ctx: TreeContext,
    tree: string,
    name: string,
    resolveBranch: BranchResolver,
  ): Promise<Branch> {
    const content = await ctx.backend.trees.read(tree, name);
    const physical = content.split('\n');
    if (physical.at(-1) === '') physical.pop();
    const entries: (EntryLine | null)[] = [];
    let header: BranchHeader = { version: 1, tree, branch: name, createdAt: Date.now() };
    let degraded = false;
    let truncateAt: number | null = null;
    const report = (kind: CorruptionKind, seq: number | null, line: number, detail: string, raw?: string): void => {
      ctx.notifyCorruption({ tree, branch: name, seq, line, kind, raw, detail });
    };
    const first = physical[0];
    if (first === undefined) {
      report('header', null, 1, 'file is empty');
      degraded = true;
    } else {
      const parsedHeader = parseHeader(first);
      if (parsedHeader.ok) {
        header = parsedHeader.value;
      } else {
        report('header', null, 1, parsedHeader.error.detail, first);
        degraded = true;
      }
    }
    const startIndex = physical.length > 0 ? 1 : 0;
    let truncated = false;
    for (let i = startIndex; i < physical.length; i++) {
      const raw = physical[i] ?? '';
      const expectedSeq = i - startIndex;
      const result = parseLine(raw, expectedSeq);
      if (!result.ok) {
        const error = result.error;
        if (error.kind === 'syntax' && i === physical.length - 1) {
          await publish(ctx, tree, name, physical.slice(0, i));
          truncated = true;
          break;
        }
        report(error.kind === 'seq' ? 'seq-gap' : error.kind, expectedSeq, i + 1, error.detail, raw);
        if (error.kind === 'seq') {
          degraded = true;
          truncateAt = i;
          break;
        }
        entries.push(null);
        continue;
      }
      entries.push(result.value);
    }
    if (!truncated && content.length > 0 && !content.endsWith('\n')) {
      await ctx.backend.trees.append(tree, name, '\n');
    }
    return new Branch(ctx, header, entries, degraded, truncateAt, resolveBranch);
  }

  append(input: AppendInput): Promise<EntryLine> {
    return this.enqueue(async () => {
      this.assertWritable();
      const seq = this.entries.length;
      const serialized = JSON.stringify(input.data ?? null);
      const size = textEncoder.encode(serialized).length;
      let payload: Payload;
      if (size > this.ctx.offloadThreshold) {
        const ref = await writeBlob(this.ctx.backend.blobs, serialized);
        payload = { kind: input.kind, size, ref };
      } else {
        payload = { kind: input.kind, size, data: input.data ?? null };
      }
      const entry: EntryLine = { kind: 'entry', seq, ts: Date.now(), type: input.type, payload };
      await this.writeLine(entry);
      this.entries.push(entry);
      this.ctx.notifyAppend(this.tree, this.name, entry);
      return entry;
    });
  }

  repair(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.degradedFlag) return;
      const content = await this.ctx.backend.trees.read(this.tree, this.name);
      const physical = content.split('\n');
      if (physical.at(-1) === '') physical.pop();
      const kept = physical.slice(0, this.truncateAt ?? physical.length);
      kept[0] = encodeHeader(this.header).replace(/\n$/, '');
      await publish(this.ctx, this.tree, this.name, kept);
      this.degradedFlag = false;
      this.truncateAt = null;
    });
  }

  settled(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  entryAt(seq: number): EntryLine | null {
    return this.entries[seq] ?? null;
  }

  tip(): EntryLine | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry !== undefined && entry !== null) return entry;
    }
    return null;
  }

  *walk(): Generator<EntryLine> {
    yield* this.walkOwn(this.entries.length - 1);
    yield* this.walkParent();
  }

  private *walkOwn(from: number): Generator<EntryLine> {
    for (let i = from; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry !== undefined && entry !== null) yield entry;
    }
  }

  private *walkParent(): Generator<EntryLine> {
    const parentBranch = this.header.parentBranch;
    const parentSeq = this.header.parentSeq;
    if (parentBranch === undefined || parentSeq === undefined) return;
    const parent = this.resolveBranch(parentBranch);
    if (parent === undefined) return;
    yield* parent.walkOwn(parentSeq);
    yield* parent.walkParent();
  }

  private async writeLine(entry: EntryLine): Promise<void> {
    await this.ctx.backend.trees.append(this.tree, this.name, encodeLine(entry));
    if (this.ctx.fsync) await this.ctx.backend.trees.sync?.(this.tree, this.name);
  }

  private assertWritable(): void {
    if (this.degradedFlag) {
      throw new StoreError('degraded', `branch ${this.tree}/${this.name} is degraded; call repair() first`);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function publish(ctx: TreeContext, tree: string, name: string, lines: string[]): Promise<void> {
  return ctx.backend.trees.write(tree, name, `${lines.join('\n')}\n`);
}
