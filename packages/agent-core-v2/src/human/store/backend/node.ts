import { access, appendFile, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';

import type { BlobBackend, StoreBackend, TreeBackend } from './backend';

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

class NodeTreeBackend implements TreeBackend {
  constructor(private readonly dir: string) {}

  async list(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  async listBranches(tree: string): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(this.dirOf(tree));
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
    return files
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => file.slice(0, -'.jsonl'.length))
      .sort();
  }

  async read(tree: string, branch: string): Promise<string> {
    return readFile(this.path(tree, branch), 'utf8');
  }

  async append(tree: string, branch: string, data: string): Promise<void> {
    await mkdir(this.dirOf(tree), { recursive: true });
    await appendFile(this.path(tree, branch), data, 'utf8');
  }

  async write(tree: string, branch: string, content: string): Promise<void> {
    await mkdir(this.dirOf(tree), { recursive: true });
    const path = this.path(tree, branch);
    await writeFile(`${path}.tmp`, content, 'utf8');
    await rename(`${path}.tmp`, path);
  }

  async sync(tree: string, branch: string): Promise<void> {
    const handle = await open(this.path(tree, branch), 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private dirOf(tree: string): string {
    return `${this.dir}/${tree}`;
  }

  private path(tree: string, branch: string): string {
    return `${this.dirOf(tree)}/${branch}.jsonl`;
  }
}

class NodeBlobBackend implements BlobBackend {
  constructor(private readonly dir: string) {}

  async has(ref: string): Promise<boolean> {
    try {
      await access(this.path(ref));
      return true;
    } catch {
      return false;
    }
  }

  async read(ref: string): Promise<string> {
    return readFile(this.path(ref), 'utf8');
  }

  async write(ref: string, data: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = this.path(ref);
    await writeFile(`${path}.tmp`, data, 'utf8');
    await rename(`${path}.tmp`, path);
  }

  private path(ref: string): string {
    return `${this.dir}/${ref}`;
  }
}

export class NodeBackend implements StoreBackend {
  readonly trees: TreeBackend;
  readonly blobs: BlobBackend;

  constructor(root: string) {
    this.trees = new NodeTreeBackend(`${root}/trees`);
    this.blobs = new NodeBlobBackend(`${root}/blobs`);
  }
}
