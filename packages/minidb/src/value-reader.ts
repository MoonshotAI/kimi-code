// src/value-reader.ts
//
// Positioned reader for disk-backed KV values. Values live inline in
// the existing db.snapshot / db.wal frames; StoreRecord only keeps a small
// { file, off, len } pointer. The synchronous read keeps the public KV API
// synchronous, mirroring the full-text postings file design; the async
// variant (stage 6) backs the explicit async read APIs (getAsync & co.) so a
// disk-mode cache miss no longer blocks the event loop on readSync.

import fs from 'node:fs';
import path from 'node:path';
import type { ValueLoc } from './store.js';

/** Promise wrapper over fs.read (the callback API runs on the libuv thread
 *  pool for a plain fd; fs.promises has no fd-level read). Shared with the
 *  postings file's async read. */
export function readAtAsync(fd: number, buf: Buffer, bufOff: number, len: number, pos: number): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.read(fd, buf, bufOff, len, pos, (err, bytesRead) => (err ? reject(err) : resolve(bytesRead)));
  });
}

export class ValueReader {
  readonly snapshotPath: string;
  readonly walPath: string;
  private snapshotFd: number | null = null;
  private walFd: number | null = null;

  constructor(dir: string) {
    this.snapshotPath = path.join(dir, 'db.snapshot');
    this.walPath = path.join(dir, 'db.wal');
  }

  /** Open both files (null-safe per side) and return the dev/ino identity of
   *  each attached handle (null = the file does not exist). Recovery's
   *  generation pairing compares these against the inodes it scanned, so a
   *  rotation landing between the scan and this attach is detected instead of
   *  serving old offsets from a new file. */
  open(): { snapshot: { dev: number; ino: number } | null; wal: { dev: number; ino: number } | null } {
    this.snapshotFd = this.openIfExists(this.snapshotPath);
    this.walFd = this.openIfExists(this.walPath);
    return { snapshot: this.ident(this.snapshotFd), wal: this.ident(this.walFd) };
  }

  private ident(fd: number | null): { dev: number; ino: number } | null {
    if (fd === null) return null;
    const st = fs.fstatSync(fd);
    return { dev: st.dev, ino: st.ino };
  }

  private openIfExists(file: string): number | null {
    try {
      return fs.openSync(file, 'r');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  private fdFor(loc: ValueLoc): number {
    const fd = loc.file === 'snapshot' ? this.snapshotFd : this.walFd;
    if (fd === null) throw new Error(`value reader: ${loc.file} file is not open`);
    return fd;
  }

  read(loc: ValueLoc): Buffer {
    if (loc.len === 0) return Buffer.alloc(0);
    const fd = this.fdFor(loc);
    const buf = Buffer.allocUnsafe(loc.len);
    let got = 0;
    while (got < loc.len) {
      const r = fs.readSync(fd, buf, got, loc.len - got, loc.off + got);
      if (r === 0) throw new Error(`value reader: short read from ${loc.file} at ${loc.off + got}`);
      got += r;
    }
    return buf;
  }

  /** Async positioned read (stage 6): identical semantics to read(), served
   *  off the libuv thread pool so a disk-mode miss does not stall the event
   *  loop. Purely additive — the synchronous read path is unchanged. */
  async readAsync(loc: ValueLoc): Promise<Buffer> {
    if (loc.len === 0) return Buffer.alloc(0);
    const fd = this.fdFor(loc);
    const buf = Buffer.allocUnsafe(loc.len);
    let got = 0;
    while (got < loc.len) {
      const r = await readAtAsync(fd, buf, got, loc.len - got, loc.off + got);
      if (r === 0) throw new Error(`value reader: short read from ${loc.file} at ${loc.off + got}`);
      got += r;
    }
    return buf;
  }

  reopenSnapshot(): void {
    if (this.snapshotFd !== null) {
      fs.closeSync(this.snapshotFd);
      this.snapshotFd = null;
    }
    this.snapshotFd = this.openIfExists(this.snapshotPath);
  }

  reopenWal(): void {
    if (this.walFd !== null) {
      fs.closeSync(this.walFd);
      this.walFd = null;
    }
    this.walFd = this.openIfExists(this.walPath);
  }

  reopenBoth(): void {
    this.reopenSnapshot();
    this.reopenWal();
  }

  close(): void {
    if (this.snapshotFd !== null) {
      fs.closeSync(this.snapshotFd);
      this.snapshotFd = null;
    }
    if (this.walFd !== null) {
      fs.closeSync(this.walFd);
      this.walFd = null;
    }
  }
}
