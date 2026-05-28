/**
 * FileMemoryStore — filesystem-backed implementation of `MemoryStore`.
 *
 * Writes are atomic (write to `.tmp-<rand>-<slug>.md`, then rename).
 * Path safety is enforced lexically via `isWithinDirectory`; the slug
 * regex (`isValidSlug`) already eliminates traversal characters.
 */

import { randomBytes } from 'node:crypto';
import { rename, unlink } from 'node:fs/promises';
import { join } from 'pathe';

import type { Kaos } from '@moonshot-ai/kaos';

import { isWithinDirectory } from '../tools/policies/path-access';
import { MEMORY_BODY_MAX_BYTES, parseMemoryFile, renderMemoryFile } from './format';
import { isValidSlug } from './slug';
import type { MemoryEntry, MemoryRecord, MemoryScope, MemoryStore } from './types';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export type MemoryErrorReason =
  | 'INVALID_SLUG'
  | 'BODY_TOO_LARGE'
  | 'EXISTS'
  | 'NOT_FOUND'
  | 'SYMLINK_REFUSED'
  | 'PATH_OUTSIDE_SCOPE';

export class MemoryStoreError extends Error {
  readonly reason: MemoryErrorReason;
  readonly scope: MemoryScope;
  readonly slug: string;

  constructor(reason: MemoryErrorReason, scope: MemoryScope, slug: string, message: string) {
    super(message);
    this.name = 'MemoryStoreError';
    this.reason = reason;
    this.scope = scope;
    this.slug = slug;
  }
}

export class FileMemoryStore implements MemoryStore {
  constructor(
    private readonly kaos: Kaos,
    private readonly userRoot: string,
    private readonly projectRoot: string,
  ) {}

  async list(scope: MemoryScope): Promise<readonly MemoryEntry[]> {
    const root = this.rootFor(scope);
    if (!(await isDir(this.kaos, root))) return [];

    const paths: string[] = [];
    for await (const entryPath of this.kaos.iterdir(root)) paths.push(entryPath);
    paths.sort();

    const out: MemoryEntry[] = [];
    for (const path of paths) {
      const name = basenameOf(path);
      if (!name.endsWith('.md')) continue;
      if (name === 'MEMORY.md') continue;
      const slug = name.slice(0, -'.md'.length);
      if (!isValidSlug(slug)) continue;
      let text: string;
      try {
        text = await this.kaos.readText(path);
      } catch {
        continue;
      }
      const entry = parseMemoryFile(scope, path, text);
      if (entry === undefined) continue;
      out.push(entry);
    }
    return out.toSorted((a, b) => a.record.name.localeCompare(b.record.name));
  }

  async read(scope: MemoryScope, slug: string): Promise<MemoryEntry | undefined> {
    if (!isValidSlug(slug)) {
      throw new MemoryStoreError(
        'INVALID_SLUG',
        scope,
        slug,
        `Invalid slug "${slug}". Must be lowercase kebab-case (1-64 chars).`,
      );
    }
    const root = this.rootFor(scope);
    const path = join(root, `${slug}.md`);
    if (!isWithinDirectory(path, root)) {
      throw new MemoryStoreError(
        'PATH_OUTSIDE_SCOPE',
        scope,
        slug,
        `Path "${path}" escapes the ${scope} memory root.`,
      );
    }

    let stat;
    try {
      stat = await this.kaos.stat(path, { followSymlinks: false });
    } catch {
      return undefined;
    }
    if ((stat.stMode & S_IFMT) === S_IFLNK) {
      throw new MemoryStoreError(
        'SYMLINK_REFUSED',
        scope,
        slug,
        `Refusing to read symlink at ${path}.`,
      );
    }

    let text: string;
    try {
      text = await this.kaos.readText(path);
    } catch {
      return undefined;
    }
    return parseMemoryFile(scope, path, text);
  }

  async write(scope: MemoryScope, record: MemoryRecord, body: string): Promise<MemoryEntry> {
    if (!isValidSlug(record.name)) {
      throw new MemoryStoreError(
        'INVALID_SLUG',
        scope,
        record.name,
        `Invalid slug "${record.name}". Must be lowercase kebab-case (1-64 chars).`,
      );
    }
    if (Buffer.byteLength(body, 'utf8') > MEMORY_BODY_MAX_BYTES) {
      throw new MemoryStoreError(
        'BODY_TOO_LARGE',
        scope,
        record.name,
        `Body exceeds the 4 KB (${String(MEMORY_BODY_MAX_BYTES)}-byte) limit.`,
      );
    }

    const root = this.rootFor(scope);
    const finalPath = join(root, `${record.name}.md`);
    if (!isWithinDirectory(finalPath, root)) {
      throw new MemoryStoreError(
        'PATH_OUTSIDE_SCOPE',
        scope,
        record.name,
        `Path "${finalPath}" escapes the ${scope} memory root.`,
      );
    }

    await this.kaos.mkdir(root, { parents: true, existOk: true });

    if (await fileExists(this.kaos, finalPath)) {
      throw new MemoryStoreError(
        'EXISTS',
        scope,
        record.name,
        `A fact already exists at slug "${record.name}" in ${scope} scope. Use operation "update" to revise it.`,
      );
    }

    const content = renderMemoryFile(record, body);
    await this.writeAtomic(finalPath, content);
    return { record, body: body.trim(), scope, path: finalPath };
  }

  async update(
    scope: MemoryScope,
    slug: string,
    patch: {
      readonly record?: Partial<MemoryRecord>;
      readonly body?: string;
    },
  ): Promise<MemoryEntry> {
    const existing = await this.read(scope, slug);
    if (existing === undefined) {
      throw new MemoryStoreError(
        'NOT_FOUND',
        scope,
        slug,
        `No fact at slug "${slug}" in ${scope} scope.`,
      );
    }

    const nextRecord: MemoryRecord = {
      name: existing.record.name,
      description: patch.record?.description ?? existing.record.description,
      type: patch.record?.type ?? existing.record.type,
    };
    const nextBody = patch.body ?? existing.body;
    if (Buffer.byteLength(nextBody, 'utf8') > MEMORY_BODY_MAX_BYTES) {
      throw new MemoryStoreError(
        'BODY_TOO_LARGE',
        scope,
        slug,
        `Body exceeds the 4 KB (${String(MEMORY_BODY_MAX_BYTES)}-byte) limit.`,
      );
    }

    const content = renderMemoryFile(nextRecord, nextBody);
    await this.writeAtomic(existing.path, content);
    return { record: nextRecord, body: nextBody.trim(), scope, path: existing.path };
  }

  async delete(scope: MemoryScope, slug: string): Promise<boolean> {
    if (!isValidSlug(slug)) {
      throw new MemoryStoreError(
        'INVALID_SLUG',
        scope,
        slug,
        `Invalid slug "${slug}". Must be lowercase kebab-case (1-64 chars).`,
      );
    }
    const root = this.rootFor(scope);
    const path = join(root, `${slug}.md`);
    if (!isWithinDirectory(path, root)) {
      throw new MemoryStoreError(
        'PATH_OUTSIDE_SCOPE',
        scope,
        slug,
        `Path "${path}" escapes the ${scope} memory root.`,
      );
    }
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  rootFor(scope: MemoryScope): string {
    return scope === 'user' ? this.userRoot : this.projectRoot;
  }

  private async writeAtomic(finalPath: string, content: string): Promise<void> {
    const slug = basenameOf(finalPath).slice(0, -'.md'.length);
    const tmpPath = join(
      finalPath.replace(/\/[^/]+$/, ''),
      `.tmp-${randomBytes(4).toString('hex')}-${slug}.md`,
    );
    let renamed = false;
    try {
      await this.kaos.writeText(tmpPath, content);
      await rename(tmpPath, finalPath);
      renamed = true;
    } finally {
      if (!renamed) {
        try {
          await unlink(tmpPath);
        } catch {
          /* ignore — file may not exist if writeText itself failed */
        }
      }
    }
  }
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

async function isDir(kaos: Kaos, path: string): Promise<boolean> {
  try {
    const stat = await kaos.stat(path);
    return (stat.stMode & S_IFMT) === S_IFDIR;
  } catch {
    return false;
  }
}

async function fileExists(kaos: Kaos, path: string): Promise<boolean> {
  try {
    await kaos.stat(path);
    return true;
  } catch {
    return false;
  }
}
