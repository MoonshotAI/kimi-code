import { createInterface, type Interface } from 'node:readline';
import type { Duplex } from 'node:stream';

export const HOST_RPC_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const RPC_BACKPRESSURE_TIMEOUT_MS = 5_000;
export const WS_BACKPRESSURE_TIMEOUT_MS = RPC_BACKPRESSURE_TIMEOUT_MS;

export class RpcBackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcBackpressureError';
  }
}

export class JsonlRpcStream<Frame extends { type: string }> {
  private readonly lines: Interface;
  private blockedTimer?: ReturnType<typeof setTimeout>;
  private cleaned = false;

  constructor(
    private readonly stream: Duplex,
    private readonly onFrame: (frame: Frame) => void,
    private readonly onDrain: () => void = () => {},
    private readonly onClose: (error?: Error) => void,
    private readonly backpressureTimeoutMs = RPC_BACKPRESSURE_TIMEOUT_MS,
  ) {
    this.lines = createInterface({ input: stream, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      try {
        onFrame(JSON.parse(trimmed) as Frame);
      } catch {
      }
    });
    stream.on('drain', this.handleDrain);
    stream.once('end', this.handleEnd);
    stream.once('close', this.handleClose);
    stream.on('error', this.handleError);
  }

  write(frame: Frame): boolean {
    if (this.cleaned || this.stream.destroyed || !this.stream.writable) return false;
    const ready = this.stream.write(`${JSON.stringify(frame)}\n`);
    if (this.stream.writableLength > HOST_RPC_MAX_BODY_BYTES) {
      this.close(new RpcBackpressureError('RPC stream exceeded its write buffer limit'));
      return false;
    }
    if (ready) return true;
    this.blockedTimer ??= setTimeout(() => {
      this.close(new RpcBackpressureError(`RPC stream remained backpressured for ${String(this.backpressureTimeoutMs)}ms`));
    }, this.backpressureTimeoutMs);
    this.blockedTimer.unref?.();
    return false;
  }

  close(error?: Error): void {
    this.finish(error);
    if (!this.stream.destroyed) this.stream.destroy();
  }

  dispose(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.blockedTimer !== undefined) clearTimeout(this.blockedTimer);
    this.blockedTimer = undefined;
    this.lines.close();
    this.stream.off('drain', this.handleDrain);
    this.stream.off('end', this.handleEnd);
    this.stream.off('close', this.handleClose);
    this.stream.off('error', this.handleError);
  }

  private readonly handleDrain = (): void => {
    if (this.blockedTimer !== undefined) clearTimeout(this.blockedTimer);
    this.blockedTimer = undefined;
    this.onDrain();
  };

  private readonly handleEnd = (): void => {
    this.close();
  };

  private readonly handleError = (error: Error): void => {
    this.finish(error);
  };

  private readonly handleClose = (): void => {
    this.finish();
  };

  private finish(error?: Error): void {
    if (this.cleaned) return;
    this.dispose();
    this.onClose(error ?? new Error('RPC stream closed'));
  }
}
