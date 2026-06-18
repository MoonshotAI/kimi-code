import { Emitter, type TerminalBackend, type TerminalProcess, type TerminalSpawnOptions } from '@moonshot-ai/agent-core';

export class FakeTerminalProcess implements TerminalProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;

  private readonly dataEmitter = new Emitter<string>();
  private readonly exitEmitter = new Emitter<{ exitCode: number | null }>();

  readonly onData = this.dataEmitter.event;
  readonly onExit = this.exitEmitter.event;

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
    this.exitEmitter.fire({ exitCode: null });
  }

  emitData(data: string): void {
    this.dataEmitter.fire(data);
  }

  emitExit(exitCode: number | null): void {
    this.exitEmitter.fire({ exitCode });
  }
}

export class FakeTerminalBackend implements TerminalBackend {
  readonly spawns: TerminalSpawnOptions[] = [];
  readonly processes: FakeTerminalProcess[] = [];

  async spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    this.spawns.push(options);
    const process = new FakeTerminalProcess();
    this.processes.push(process);
    return process;
  }
}
