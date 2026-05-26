/**
 * Small atomic JSON file store used by the MCP OAuth provider to persist
 * tokens, registered client info, and discovery state under
 * `<KIMI_CODE_HOME>/credentials/mcp/` (default
 * `~/.kimi-code/credentials/mcp/`).
 *
 * Write semantics: write to `<file>.tmp.<pid>.<rand>` → fsync → rename.
 * Atomic on POSIX; best-effort on Windows. Files land at mode 0600 (parent
 * dir 0700) so other local users cannot read tokens.
 *
 * Read semantics: missing file → undefined. Corrupt JSON / wrong shape →
 * undefined (never throws). The provider treats undefined as "not stored".
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'pathe';

export function mcpCredentialsDir(kimiHomeDir: string): string {
  return join(kimiHomeDir, 'credentials', 'mcp');
}

export function defaultMcpCredentialsDir(): string {
  return mcpCredentialsDir(join(homedir(), '.kimi-code'));
}

export function sanitizeStoreKey(name: string): string {
  // Strip path-traversal segments. Tokens land under `<key>-<suffix>.json`,
  // so the sanitized value must also be a single filename component.
  const safe = basename(name).replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');
  if (safe.length === 0 || safe.startsWith('.')) {
    throw new Error(`Invalid MCP OAuth store key: "${name}"`);
  }
  return safe;
}

export function canonicalMcpOAuthResource(serverUrl: string | URL): string {
  const url = new URL(serverUrl);
  url.hash = '';
  return url.toString();
}

export function mcpOAuthStoreKey(serverName: string, serverUrl: string | URL): string {
  const safeName = sanitizeStoreKey(serverName);
  const resource = canonicalMcpOAuthResource(serverUrl);
  const digest = createHash('sha256')
    .update(serverName)
    .update('\0')
    .update(resource)
    .digest('hex')
    .slice(0, 24);
  return `${safeName}-${digest}`;
}

export class JsonFileStore {
  private readonly dir: string;

  constructor(dir: string = defaultMcpCredentialsDir()) {
    this.dir = dir;
  }

  read<T>(file: string): T | undefined {
    const path = join(this.dir, file);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  write(file: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // best-effort; Windows / read-only FS may refuse
    }
    const target = join(this.dir, file);
    const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    const buf = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    const fd = openSync(tmp, 'w', 0o600);
    try {
      let written = 0;
      while (written < buf.length) {
        written += writeSync(fd, buf, written, buf.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  remove(file: string): void {
    try {
      unlinkSync(join(this.dir, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
