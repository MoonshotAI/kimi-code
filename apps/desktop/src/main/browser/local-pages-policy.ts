import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const FUSE_WIRE_VERSION = 1;
const GRANT_FILE_PROTOCOL_EXTRA_PRIVILEGES = 7;
const FUSE_DISABLED = 0x30;
const WIRE_BYTES = SENTINEL.length + 2 + GRANT_FILE_PROTOCOL_EXTRA_PRIVILEGES + 1;

export const UNSAFE_LOCAL_PAGES_ENV = 'KIMI_DESKTOP_UNSAFE_LOCAL_PAGES';
export const FUSE_READ_TIMEOUT_MS = 10_000;

export function electronFuseBinary(execPath: string, platform: NodeJS.Platform): string {
  if (platform !== 'darwin') return execPath;
  return resolve(dirname(execPath), '..', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
}

export async function fileProtocolPrivilegesDisabled(binary: string, chunkSize = 1 << 20): Promise<boolean> {
  const handle = await open(binary, 'r');
  try {
    let carry = Buffer.alloc(0);
    let position = 0;
    let found = false;
    for (;;) {
      const chunk = Buffer.alloc(chunkSize);
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      for (let index = data.indexOf(SENTINEL); index !== -1 && index + WIRE_BYTES <= data.length; index = data.indexOf(SENTINEL, index + 1)) {
        const wire = index + SENTINEL.length;
        if (data[wire] !== FUSE_WIRE_VERSION || data[wire + 1]! <= GRANT_FILE_PROTOCOL_EXTRA_PRIVILEGES) return false;
        if (data[wire + 2 + GRANT_FILE_PROTOCOL_EXTRA_PRIVILEGES] !== FUSE_DISABLED) return false;
        found = true;
      }
      carry = Buffer.from(data.subarray(Math.max(0, data.length - WIRE_BYTES + 1)));
    }
    return found;
  } finally {
    await handle.close();
  }
}

export interface LocalPagesPolicyOptions {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  execPath: string;
  platform: NodeJS.Platform;
  warn: (message: string) => void;
  readFuse?: (binary: string) => Promise<boolean>;
}

export interface LocalPagesPolicy {
  (): Promise<boolean>;
  extraPrivileges: () => boolean;
}

export function createLocalPagesPolicy(options: LocalPagesPolicyOptions): LocalPagesPolicy {
  let decision: Promise<boolean> | null = null;
  let privileges = true;
  const allowed = (): Promise<boolean> => {
    decision ??= decide(options, (value) => { privileges = value; });
    return decision;
  };
  return Object.assign(allowed, { extraPrivileges: () => privileges });
}

async function readFuseWithin(options: LocalPagesPolicyOptions): Promise<boolean> {
  const readFuse = options.readFuse ?? fileProtocolPrivilegesDisabled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readFuse(electronFuseBinary(options.execPath, options.platform)).catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          options.warn(`[kimi-desktop] reading the grantFileProtocolExtraPrivileges fuse timed out after ${FUSE_READ_TIMEOUT_MS}ms: local HTML pages stay off for this run`);
          resolve(false);
        }, FUSE_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function decide(options: LocalPagesPolicyOptions, keepPrivileges: (value: boolean) => void): Promise<boolean> {
  if (options.isPackaged) {
    const disabled = await readFuseWithin(options);
    if (disabled) {
      keepPrivileges(false);
      return true;
    }
  }
  if (options.env[UNSAFE_LOCAL_PAGES_ENV] !== '1') return false;
  options.warn(`[kimi-desktop] ${UNSAFE_LOCAL_PAGES_ENV}=1: local HTML pages run with Electron's extra file:// privileges and can read other local files. This flag cannot reproduce shipped file:// behaviour, because grantFileProtocolExtraPrivileges is a build-time property of the binary: module scripts, workers, cross-frame DOM access, canvas tainting, service workers and storage all behave differently here than in a packaged build.`);
  return true;
}
