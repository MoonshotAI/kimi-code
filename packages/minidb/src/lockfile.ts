import {
  type KernelFileLockHandle,
  tryAcquireKernelFileLock,
} from '@moonshot-ai/kernel-file-lock';

export class LockError extends Error {
  readonly code = 'ELOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

export class LockFile {
  readonly path: string;
  held = false;

  private handle: KernelFileLockHandle | undefined;

  constructor(path: string) {
    this.path = path;
  }

  async acquire(): Promise<boolean> {
    if (this.held) return true;
    const handle = tryAcquireKernelFileLock(this.path);
    if (handle === undefined) return false;
    this.handle = handle;
    this.held = true;
    return true;
  }

  checkHeld(): boolean {
    if (!this.held || this.handle === undefined) return false;
    if (this.handle.checkHeld()) return true;
    this.markLost();
    return false;
  }

  assertHeld(): void {
    if (!this.checkHeld()) throw new LockError(`database write lock was lost: ${this.path}`);
  }

  releaseSync(): void {
    if (!this.held) return;
    this.held = false;
    const handle = this.handle;
    this.handle = undefined;
    handle?.release();
  }

  private markLost(): void {
    this.releaseSync();
  }
}
