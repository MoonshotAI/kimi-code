import type { StoreBackend } from './backend/backend';
import { readBlob } from './internal/blob';
import { parseHeader, parseLine } from './internal/codec';
import type { TreeContext } from './internal/context';
import { Tree } from './tree';
import type { CorruptionReport, Subscriber, TreeStoreOptions } from './types';
import { DEFAULT_OFFLOAD_THRESHOLD, StoreError, isOffloadedPayload } from './types';

const TREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface SubscriberEntry {
  prefix: string;
  subscriber: Subscriber;
}

export class TreeStore {
  private readonly backend: StoreBackend;
  private readonly trees = new Map<string, Tree>();
  private readonly subscribers: SubscriberEntry[] = [];
  private readonly ctx: TreeContext;

  private constructor(backend: StoreBackend, opts: TreeStoreOptions) {
    this.backend = backend;
    this.ctx = {
      backend,
      offloadThreshold: opts.offloadThreshold ?? DEFAULT_OFFLOAD_THRESHOLD,
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

  static async open(backend: StoreBackend, opts: TreeStoreOptions = {}): Promise<TreeStore> {
    const store = new TreeStore(backend, opts);
    for (const name of await backend.trees.list()) {
      const tree = new Tree(store.ctx, name);
      for (const branchName of await backend.trees.listBranches(name)) {
        await tree.loadBranch(branchName);
      }
      store.trees.set(name, tree);
    }
    return store;
  }

  names(): string[] {
    return [...this.trees.keys()];
  }

  async tree(name: string): Promise<Tree> {
    const existing = this.trees.get(name);
    if (existing !== undefined) return existing;
    if (!TREE_NAME_PATTERN.test(name)) {
      throw new StoreError('invalid-name', `invalid tree name ${name}`);
    }
    const created = new Tree(this.ctx, name);
    this.trees.set(name, created);
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

  async verify(opts?: { blobs?: boolean }): Promise<CorruptionReport[]> {
    const reports: CorruptionReport[] = [];
    for (const [name, tree] of this.trees) {
      for (const branchName of tree.branches()) {
        reports.push(...(await this.verifyBranch(name, branchName, tree, opts?.blobs === true)));
      }
    }
    return reports;
  }

  private async verifyBranch(
    name: string,
    branchName: string,
    tree: Tree,
    checkBlobs: boolean,
  ): Promise<CorruptionReport[]> {
    const reports: CorruptionReport[] = [];
    const branch = tree.openBranch(branchName);
    let content: string;
    try {
      content = await this.backend.trees.read(name, branchName);
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
    const refs: string[] = [];
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
        continue;
      }
      if (isOffloadedPayload(result.value.payload)) refs.push(result.value.payload.ref);
    }
    const header = branch.header;
    if (header.parentBranch !== undefined) {
      const parent = tree.has(header.parentBranch) ? tree.openBranch(header.parentBranch) : undefined;
      const parentExists = (await this.backend.trees.listBranches(name)).includes(header.parentBranch);
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
    if (checkBlobs) {
      for (const ref of refs) {
        try {
          await readBlob(this.backend.blobs, ref);
        } catch (error) {
          if (error instanceof StoreError && (error.code === 'blob-missing' || error.code === 'blob-crc')) {
            reports.push({
              tree: name,
              branch: branchName,
              seq: null,
              line: 0,
              kind: error.code,
              detail: error.message,
            });
          } else {
            throw error;
          }
        }
      }
    }
    return reports;
  }
}
