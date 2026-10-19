import { Branch } from './branch';
import { readBlob } from './internal/blob';
import type { TreeContext } from './internal/context';
import type { BranchRef, EntryLine } from './types';
import { isOffloadedPayload, StoreError } from './types';

const BRANCH_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._~-]*$/;

export class Tree {
  readonly name: string;
  private readonly ctx: TreeContext;
  private readonly branchMap = new Map<string, Branch>();

  constructor(ctx: TreeContext, name: string) {
    this.ctx = ctx;
    this.name = name;
  }

  branches(): string[] {
    return [...this.branchMap.keys()].sort();
  }

  has(name: string): boolean {
    return this.branchMap.has(name);
  }

  openBranch(name: string): Branch {
    const branch = this.branchMap.get(name);
    if (branch === undefined) {
      throw new StoreError('unknown-branch', `unknown branch ${this.name}/${name}`);
    }
    return branch;
  }

  createBranch(name: string, opts?: { from?: BranchRef }): Branch {
    if (this.branchMap.has(name)) {
      throw new StoreError('duplicate-branch', `branch ${this.name}/${name} already exists`);
    }
    if (!BRANCH_NAME_PATTERN.test(name)) {
      throw new StoreError('invalid-name', `invalid branch name ${name}`);
    }
    const from = opts?.from;
    if (from !== undefined) {
      const parent = this.branchMap.get(from.branch);
      if (parent === undefined) {
        throw new StoreError('unknown-branch', `unknown branch ${this.name}/${from.branch}`);
      }
      if (!Number.isSafeInteger(from.seq) || from.seq < 0 || from.seq >= parent.nextSeq) {
        throw new StoreError('invalid-target', `cannot fork ${from.branch} at ${from.seq}`);
      }
    }
    const branch = Branch.create(this.ctx, this.name, name, (n) => this.branchMap.get(n), from);
    this.branchMap.set(name, branch);
    return branch;
  }

  async loadBranch(name: string): Promise<Branch> {
    if (this.branchMap.has(name)) {
      throw new StoreError('duplicate-branch', `branch ${this.name}/${name} already exists`);
    }
    const branch = await Branch.load(this.ctx, this.name, name, (n) => this.branchMap.get(n));
    this.branchMap.set(name, branch);
    return branch;
  }

  async resolve(entry: EntryLine): Promise<unknown> {
    if (isOffloadedPayload(entry.payload)) {
      return JSON.parse(await readBlob(this.ctx.backend.blobs, entry.payload.ref)) as unknown;
    }
    return entry.payload.data;
  }
}
