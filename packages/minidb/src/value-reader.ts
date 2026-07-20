// src/value-reader.ts
//
// Synchronous positioned reader for disk-backed KV values. Values live inline in
// the existing db.snapshot / db.wal frames; StoreRecord only keeps a small
// { file, off, len } pointer. Synchronous reads keep the public KV API
// synchronous, mirroring the full-text postings file design.

import fs from 'node:fs';
import path from 'node:path';
import type { ValueLoc } from './store.js';

export class ValueReader {
  readonly snapshotPath: string;
  readonly walPath: string;
  private snapshotFd: number | null = null;
  private walFd: number | null = null;

  constructor(dir: string) {
    this.snapshotPath = path.join(dir, 'db.snapshot');
    this.walPath = path.join(dir, 'db.wal');
  }

  open(): void {
    this.snapshotFd = this.openIfExists(this.snapshotPath);
    this.walFd = this.openIfExists(this.walPath);
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
