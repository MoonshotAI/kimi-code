import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { sha256Hex } from '@moonshot-ai/core/utils/hash';
import lockfile from 'proper-lockfile';
import { ErrorCode } from '../protocol/error-codes';

export const EDITABLE_FILE_MAX_BYTES = 10 * 1024 * 1024;

export class FileWriteError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}

const forbidden = () => new FileWriteError(ErrorCode.FS_WRITE_NOT_ALLOWED, 'Writing this file is not allowed');
const changed = () => new FileWriteError(ErrorCode.FS_CONTENT_CHANGED, 'File changed since it was opened; reload before saving');

function hasFsCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export class WritableHostFiles {
  private readonly allowed: ReadonlySet<string>;

  constructor(homeDir: string) {
    this.allowed = new Set([resolve(homeDir, 'AGENTS.md')]);
  }

  async replace(path: string, content: string, revision: string): Promise<{ revision: string }> {
    if (!this.allowed.has(path)) throw forbidden();
    const release = await lockfile.lock(path, {
      realpath: false,
      retries: { retries: 60, minTimeout: 25, maxTimeout: 250, randomize: true },
    });
    try {
      return await this.replaceChecked(path, content, revision);
    } finally {
      await release();
    }
  }

  private async replaceChecked(path: string, content: string, revision: string): Promise<{ revision: string }> {
    const original = await lstat(path).catch((err: unknown) => {
      if (hasFsCode(err, 'ENOENT')) return null;
      throw err;
    });
    if (original && !original.isFile()) throw forbidden();
    if (original) {
      if (revision === 'missing') throw changed();
      if (original.size > EDITABLE_FILE_MAX_BYTES) throw new FileWriteError(ErrorCode.FS_TOO_LARGE, 'File exceeds the edit size limit');
      await access(path, constants.W_OK);
    } else if (revision !== 'missing') throw changed();

    const bytes = Buffer.from(content, 'utf8');
    const tmp = join(dirname(path), `.kimi-edit-${randomUUID()}`);
    const output = await open(tmp, 'wx', 0o600);
    try {
      try {
        await output.writeFile(bytes);
        if (original) await output.chmod(original.mode & 0o777);
      } finally {
        await output.close();
      }
      if (original) {
        const current = await lstat(path);
        if (!current.isFile()) throw forbidden();
        const input = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const stat = await input.stat();
          if (!stat.isFile() || stat.size > EDITABLE_FILE_MAX_BYTES || sha256Hex(await input.readFile()) !== revision) throw changed();
        } finally {
          await input.close();
        }
        await rename(tmp, path);
      } else {
        await link(tmp, path).catch((err: unknown) => {
          if (hasFsCode(err, 'EEXIST')) throw changed();
          throw err;
        });
      }
    } finally {
      await unlink(tmp).catch((err: unknown) => {
        if (!hasFsCode(err, 'ENOENT')) throw err;
      });
    }
    return { revision: sha256Hex(bytes) };
  }
}
