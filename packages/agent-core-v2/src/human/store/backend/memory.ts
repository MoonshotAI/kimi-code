import type { BlobBackend, StoreBackend, TreeBackend } from './backend';

export class MemoryTreeBackend implements TreeBackend {
  readonly files = new Map<string, Map<string, string>>();

  async list(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }

  async listBranches(tree: string): Promise<string[]> {
    return [...(this.files.get(tree)?.keys() ?? [])].sort();
  }

  async read(tree: string, branch: string): Promise<string> {
    const content = this.files.get(tree)?.get(branch);
    if (content === undefined) throw new Error(`ENOENT: no such branch ${tree}/${branch}`);
    return content;
  }

  async append(tree: string, branch: string, data: string): Promise<void> {
    const file = this.file(tree);
    file.set(branch, (file.get(branch) ?? '') + data);
  }

  async write(tree: string, branch: string, content: string): Promise<void> {
    this.file(tree).set(branch, content);
  }

  private file(tree: string): Map<string, string> {
    let file = this.files.get(tree);
    if (file === undefined) {
      file = new Map();
      this.files.set(tree, file);
    }
    return file;
  }
}

export class MemoryBlobBackend implements BlobBackend {
  readonly files = new Map<string, string>();

  async has(ref: string): Promise<boolean> {
    return this.files.has(ref);
  }

  async read(ref: string): Promise<string> {
    const content = this.files.get(ref);
    if (content === undefined) throw new Error(`ENOENT: no such blob ${ref}`);
    return content;
  }

  async write(ref: string, data: string): Promise<void> {
    this.files.set(ref, data);
  }
}

export class MemoryBackend implements StoreBackend {
  readonly trees = new MemoryTreeBackend();
  readonly blobs = new MemoryBlobBackend();
}
