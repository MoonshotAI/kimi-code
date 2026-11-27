type Release = () => void;

interface PendingRequest {
  resolve: (release: Release) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
}

export class BackgroundRequestQueue {
  private active = 0;
  private closed = false;
  private readonly pending: PendingRequest[] = [];

  assertOpen(): void {
    if (this.closed) throw new DOMException('Request queue disposed', 'AbortError');
  }

  acquire(signal?: AbortSignal): Promise<Release> {
    this.assertOpen();
    signal?.throwIfAborted();
    return new Promise<Release>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.pending.indexOf(entry);
          if (index === -1) return;
          this.pending.splice(index, 1);
          signal?.removeEventListener('abort', entry.abort);
          reject(signal?.reason ?? new DOMException('Request aborted', 'AbortError'));
        },
      };
      this.pending.push(entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.drain();
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.splice(0)) {
      entry.signal?.removeEventListener('abort', entry.abort);
      entry.reject(new DOMException('Request queue disposed', 'AbortError'));
    }
  }

  private drain(): void {
    while (!this.closed && this.active < 2 && this.pending.length > 0) {
      const entry = this.pending.shift()!;
      entry.signal?.removeEventListener('abort', entry.abort);
      this.active += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      });
    }
  }
}
