export interface BlobBackend {
  has(key: string): Promise<boolean>;
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, data: Uint8Array): Promise<void>;
}
