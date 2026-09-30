export interface TreeBackend {
  list(): Promise<string[]>;
  listBranches(tree: string): Promise<string[]>;
  read(tree: string, branch: string): Promise<string>;
  append(tree: string, branch: string, data: string): Promise<void>;
  write(tree: string, branch: string, content: string): Promise<void>;
  sync?(tree: string, branch: string): Promise<void>;
}

export interface BlobBackend {
  has(ref: string): Promise<boolean>;
  read(ref: string): Promise<string>;
  write(ref: string, data: string): Promise<void>;
}

export interface StoreBackend {
  readonly trees: TreeBackend;
  readonly blobs: BlobBackend;
}
