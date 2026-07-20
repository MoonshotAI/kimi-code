/**
 * `_base/execEnv` (L0) — `BufferedReadable` stream helper.
 *
 * A `Readable` wrapper that preserves source backpressure while still allowing
 * consumers to read buffered output after the source has ended. Used by process
 * spawners so `wait()`-then-read on small/medium outputs works without draining
 * unboundedly. Vendored from `@moonshot-ai/kaos` `internal.ts`; kept as a pure
 * helper with no DI dependencies.
 */

import { Readable } from 'node:stream';

export class BufferedReadable extends Readable {
  private readonly _source: Readable;
  private _ended: boolean = false;

  constructor(source: Readable) {
    super({ highWaterMark: 128 * 1024 });
    this._source = source;
    this._source.on('data', this._onData);
    this._source.on('end', this._onEnd);
    this._source.on('close', this._onClose);
    this._source.on('error', this._onError);
  }

  override _read(): void {
    if (!this._ended && !this.destroyed) {
      this._source.resume();
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this._source.off('data', this._onData);
    this._source.off('end', this._onEnd);
    this._source.off('close', this._onClose);
    this._source.off('error', this._onError);
    this._source.destroy();
    callback(error);
  }

  private readonly _onData = (chunk: string | Uint8Array): void => {
    if (!this.push(chunk)) {
      this._source.pause();
    }
  };

  private readonly _onEnd = (): void => {
    this._ended = true;
    this.push(null);
  };

  private readonly _onClose = (): void => {
    if (!this._ended) {
      this._ended = true;
      this.push(null);
    }
  };

  private readonly _onError = (error: Error): void => {
    this.destroy(error);
  };
}
