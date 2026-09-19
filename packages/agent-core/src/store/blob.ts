export interface BlobRef {
  readonly ref: string;
  readonly size: number;
}

export interface BlobBackend {
  has(ref: string): Promise<boolean>;
  read(ref: string): Promise<Uint8Array>;
  write(ref: string, data: Uint8Array): Promise<void>;
}

export interface Blobs {
  put(bytes: Uint8Array): Promise<BlobRef>;
  get(ref: string): Promise<Uint8Array>;
  has(ref: string): Promise<boolean>;
}

export class BlobMissingError extends Error {
  constructor(readonly ref: string) {
    super(`Blob '${ref}' is missing`);
    this.name = 'BlobMissingError';
  }
}

export class BlobIntegrityError extends Error {
  constructor(readonly ref: string) {
    super(`Blob '${ref}' failed its hash check`);
    this.name = 'BlobIntegrityError';
  }
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function openBlobs(backend: BlobBackend): Blobs {
  return {
    put: async (bytes) => {
      const stored = bytes.slice();
      const ref = await sha256Hex(stored);
      if (!(await backend.has(ref))) await backend.write(ref, stored);
      return { ref, size: stored.byteLength };
    },
    get: async (ref) => {
      if (!(await backend.has(ref))) throw new BlobMissingError(ref);
      const data = await backend.read(ref);
      if ((await sha256Hex(data)) !== ref) throw new BlobIntegrityError(ref);
      return data.slice();
    },
    has: (ref) => backend.has(ref),
  };
}

export function memoryBlobs(): Blobs {
  const files = new Map<string, Uint8Array>();
  return openBlobs({
    has: async (ref) => files.has(ref),
    read: async (ref) => {
      const data = files.get(ref);
      if (data === undefined) throw new BlobMissingError(ref);
      return data;
    },
    write: async (ref, data) => {
      files.set(ref, data);
    },
  });
}
