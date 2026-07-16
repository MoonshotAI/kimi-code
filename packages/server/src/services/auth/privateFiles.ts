import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname } from 'node:path';

export class PrivateFileTooPermissiveError extends Error {
  readonly code = 'EPRIVATE_FILE_TOO_PERMISSIVE';

  constructor(
    readonly filePath: string,
    readonly mode: number,
  ) {
    super(
      `private file ${filePath} is too permissive (mode ${mode.toString(8).padStart(3, '0')}); expected 0600`,
    );
    this.name = 'PrivateFileTooPermissiveError';
  }
}

export async function writePrivateFile(
  filePath: string,
  data: string | Buffer,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  const tmp = `${filePath}.tmp.${randomBytes(8).toString('hex')}`;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, 'w', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, filePath);
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readPrivateFile(filePath: string): Promise<Buffer> {
  const info = await stat(filePath);
  // Windows does not have Unix-style permission bits; libuv synthesises the
  // mode from the read-only attribute, so a private writable file is reported
  // as 0o666 and a read-only one as 0o444. The ACL-based security model is
  // different, so this check only makes sense on POSIX systems.
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new PrivateFileTooPermissiveError(filePath, info.mode & 0o777);
  }
  return readFile(filePath);
}
