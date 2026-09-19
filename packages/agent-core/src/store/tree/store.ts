import type { TreeBackend } from './backend/backend';
import { parseHeader, parseLine } from './codec';
import type { TreeContext } from './context';
import { Tree } from './tree';
import type { CorruptionReport, Subscriber, TreesOptions } from './types';
import { StoreError } from './types';

const TREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface SubscriberEntry {
  prefix: string;
  subscriber: Subscriber;
}

export class Trees {
  private readonly backend: TreeBackend;
  private readonly byName = new Map<string, Tree>();
  private readonly subscribers: SubscriberEntry[] = [];
  private readonly ctx: TreeContext;

  private constructor(backend: TreeBackend, opts: TreesOptions) {
    this.backend = backend;
    this.ctx = {
      backend,
      fsync: opts.fsync ?? false,
      notifyAppend: (tree, branch, entry) => {
        for (const { prefix, subscriber } of this.subscribers) {
          if (entry.type.startsWith(prefix)) subscriber.onAppend?.(tree, branch, entry);
        }
      },
      notifyCorruption: (report) => {
        for (const { subscriber } of this.subscribers) subscriber.onCorruption?.(report);
      },
    };
    for (const { prefix, subscriber } of opts.subscribers ?? []) {
      this.subscribers.push({ prefix, subscriber });
    }
  }

  static async open(backend: TreeBackend, opts: TreesOptions = {}): Promise<Trees> {
    const root = new Trees(backend, opts);
    for (const name of await backend.list()) {
      const tree = new Tree(root.ctx, name);
      for (const branchName of await backend.listBranches(name)) {
        await tree.loadBranch(branchName);
      }
      root.byName.set(name, tree);
    }
    return root;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  async tree(name: string): Promise<Tree> {
    const existing = this.byName.get(name);
    if (existing !== undefined) return existing;
    if (!TREE_NAME_PATTERN.test(name)) {
      throw new StoreError('invalid-name', `invalid tree name ${name}`);
    }
    const created = new Tree(this.ctx, name);
    this.byName.set(name, created);
    return created;
  }

  subscribe(prefix: string, subscriber: Subscriber): () => void {
    const entry: SubscriberEntry = { prefix, subscriber };
    this.subscribers.push(entry);
    return () => {
      const index = this.subscribers.indexOf(entry);
      if (index >= 0) this.subscribers.splice(index, 1);
    };
  }

  async verify(): Promise<CorruptionReport[]> {
    const reports: CorruptionReport[] = [];
    for (const [name, tree] of this.byName) {
      for (const branchName of tree.branches()) {
        reports.push(...(await this.verifyBranch(name, branchName, tree)));
      }
    }
    return reports;
  }

  private async verifyBranch(name: string, branchName: string, tree: Tree): Promise<CorruptionReport[]> {
    const reports: CorruptionReport[] = [];
    const branch = tree.openBranch(branchName);
    let content: string;
    try {
      content = await this.backend.read(name, branchName);
    } catch (error) {
      reports.push({
        tree: name,
        branch: branchName,
        seq: null,
        line: 0,
        kind: 'missing',
        detail: error instanceof Error ? error.message : 'branch file is missing',
      });
      return reports;
    }
    const physical = content.split('\n');
    if (physical.at(-1) === '') physical.pop();
    const first = physical[0] ?? '';
    const parsedHeader = parseHeader(first);
    if (!parsedHeader.ok) {
      reports.push({
        tree: name,
        branch: branchName,
        seq: null,
        line: 1,
        kind: 'header',
        raw: first,
        detail: parsedHeader.error.detail,
      });
    }
    for (let i = 1; i < physical.length; i++) {
      const raw = physical[i] ?? '';
      const expectedSeq = i - 1;
      const result = parseLine(raw, expectedSeq);
      if (!result.ok) {
        reports.push({
          tree: name,
          branch: branchName,
          seq: expectedSeq,
          line: i + 1,
          kind: result.error.kind === 'seq' ? 'seq-gap' : result.error.kind,
          raw,
          detail: result.error.detail,
        });
      }
    }
    const header = branch.header;
    if (header.parentBranch !== undefined) {
      const parent = tree.has(header.parentBranch) ? tree.openBranch(header.parentBranch) : undefined;
      const parentExists = (await this.backend.listBranches(name)).includes(header.parentBranch);
      if (parent === undefined || !parentExists) {
        reports.push({
          tree: name,
          branch: branchName,
          seq: null,
          line: 1,
          kind: 'parent-ref',
          detail: `parent branch ${header.parentBranch} is missing`,
        });
      } else if (header.parentSeq !== undefined && header.parentSeq >= parent.nextSeq) {
        reports.push({
          tree: name,
          branch: branchName,
          seq: null,
          line: 1,
          kind: 'parent-ref',
          detail: `parent seq ${header.parentSeq} is beyond ${header.parentBranch}`,
        });
      }
    }
    return reports;
  }
}
