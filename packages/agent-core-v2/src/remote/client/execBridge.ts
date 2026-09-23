import { spawn, type ChildProcess } from 'node:child_process';

export interface BytePipe {
  write(chunk: Uint8Array): void;
  end(): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  onEnd(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface ExecBridgeOptions {
  readonly program: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
}

export interface ExecBridgeExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

const DEFAULT_STDERR_LIMIT = 64 * 1024;

export class ExecBridge implements BytePipe {
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly endListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private stderrTail = '';
  private endFired = false;
  private stdinBroken = false;
  private closeTimer: NodeJS.Timeout | undefined;
  readonly exited: Promise<ExecBridgeExit>;

  private constructor(private readonly child: ChildProcess) {
    this.child.stdout!.on('data', (chunk: Buffer) => {
      for (const listener of this.dataListeners) listener(chunk);
    });
    this.child.stdout!.on('end', () => {
      this.fireEnd();
    });
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-DEFAULT_STDERR_LIMIT);
    });

    if (this.child.stdin !== null) {
      this.child.stdin.on('error', () => {
        this.breakStdin();
      });
    }
    this.child.on('error', (error: Error) => {
      for (const listener of this.errorListeners) listener(error);
      this.fireEnd();
    });

    this.child.on('exit', () => {
      this.breakStdin();
    });
    this.exited = new Promise<ExecBridgeExit>((resolve) => {
      this.child.on('error', (error: Error) => {
        resolve({ code: null, signal: null, error });
      });
      this.child.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });
  }

  static spawn(options: ExecBridgeOptions): ExecBridge {
    const child = spawn(options.program, [...(options.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
      windowsHide: true,
    });
    return new ExecBridge(child);
  }

  static adopt(child: ChildProcess): ExecBridge {
    return new ExecBridge(child);
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  write(chunk: Uint8Array): void {
    if (this.stdinBroken) return;
    this.child.stdin!.write(chunk);
  }

  end(): void {
    if (this.stdinBroken) return;
    this.child.stdin!.end();
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.add(listener);
  }

  onEnd(listener: () => void): void {
    if (this.endFired) {
      listener();
      return;
    }
    this.endListeners.add(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.add(listener);
  }

  close(): void {
    if (this.closeTimer !== undefined) return;
    try {
      this.child.stdin!.end();
    } catch {
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
    }
    this.closeTimer = setTimeout(() => {
      try {
        this.child.kill('SIGKILL');
      } catch {
      }
    }, 500);
    this.closeTimer.unref?.();
  }

  private breakStdin(): void {
    this.stdinBroken = true;
    this.fireEnd();
  }

  private fireEnd(): void {
    if (this.endFired) return;
    this.endFired = true;
    for (const listener of this.endListeners) listener();
    this.endListeners.clear();
  }
}
