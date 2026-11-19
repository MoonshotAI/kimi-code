import { TestkitError } from '#/errors';
import { kimiCliCommand, kimiCliEnv, kimiServiceStubs } from '#/fixtures/cli';
import type { TestHome } from '#/fixtures/home';
import type { FetchStub } from '#/fixtures/network';
import { TestProcess, type NodeCommand, type ProcessExit } from '#/fixtures/process';
import { TIMEOUTS } from '#/fixtures/timeouts';
import { KapClient } from '#/kap/client';
import type { KapFrame } from '#/kap/frames';

export interface StartKapProcessOptions {
  readonly home: TestHome;
  readonly command?: NodeCommand;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchStubs?: readonly FetchStub[];
  readonly onFrame?: (frame: KapFrame) => void;
}

interface ReadyLine {
  readonly origin: string;
  readonly token: string;
}

export class KapProcess extends KapClient {
  readonly pid: number;
  private readonly child: TestProcess;
  private stopping: Promise<void> | undefined;

  private constructor(child: TestProcess, ready: ReadyLine, options: StartKapProcessOptions) {
    super({ origin: () => ready.origin, token: () => ready.token }, { workspace: options.home.workspace, onFrame: options.onFrame });
    this.child = child;
    this.pid = child.pid;
  }

  static async start(options: StartKapProcessOptions): Promise<KapProcess> {
    const child = TestProcess.start({
      label: 'KAP server',
      command: options.command ?? kimiCliCommand(),
      args: ['web', '--port', '0', '--json'],
      cwd: options.home.workspace,
      env: kimiCliEnv(options.home, options.env),
      logDir: options.home.root,
      fetchStubs: [...kimiServiceStubs(), ...(options.fetchStubs ?? [])],
    });
    try {
      const line = await child.waitForLine((text) => text.trimStart().startsWith('{'), { description: 'the KAP ready line' });
      return new KapProcess(child, readyLineOf(line), options);
    } catch (cause) {
      await child.forceKill();
      throw new TestkitError(`The KAP server failed to start\n${child.describe()}`, { cause });
    }
  }

  describe(): string {
    return this.child.describe();
  }

  close(): Promise<void> {
    this.stopping ??= this.stop('close');
    return this.stopping;
  }

  crash(): Promise<void> {
    this.stopping ??= this.stop('crash');
    return this.stopping;
  }

  private async stop(mode: 'close' | 'crash'): Promise<void> {
    const exitedEarly = this.child.exited;
    try {
      const exit = mode === 'crash' ? await this.child.forceKill() : await this.shutdown();
      await this.closeSockets();
      const blocked = await this.child.networkViolations();
      if (blocked.length > 0) throw new TestkitError(`The KAP server tried to reach non-loopback addresses: ${blocked.join(', ')}`);
      const expected = mode === 'crash' ? killedByTest(exit) : exit.code === 0;
      if (exitedEarly || !expected) throw new TestkitError(`The KAP server ended unexpectedly while the test asked it to ${mode}`);
    } catch (cause) {
      await this.child.forceKill();
      await this.closeSockets();
      throw new TestkitError(`Could not ${mode} the KAP server\n${this.child.describe()}`, { cause });
    }
  }

  private async shutdown(): Promise<ProcessExit> {
    await this.closeSockets();
    await this.rest.request('/api/v1/shutdown', { method: 'POST', body: {}, signal: AbortSignal.timeout(TIMEOUTS.wait) });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.child.forceKill();
    }, TIMEOUTS.server);
    try {
      const exit = await this.child.closed;
      if (timedOut) throw new TestkitError(`The KAP server did not exit within ${TIMEOUTS.server} ms after the shutdown request`);
      return exit;
    } finally {
      clearTimeout(timer);
    }
  }
}

function killedByTest(exit: ProcessExit): boolean {
  return process.platform === 'win32' ? exit.code !== 0 : exit.signal === 'SIGKILL';
}

function readyLineOf(line: string): ReadyLine {
  const ready = JSON.parse(line) as { readonly origin?: unknown; readonly ws_url?: unknown; readonly token?: unknown };
  if (typeof ready.origin !== 'string' || typeof ready.token !== 'string' || ready.token === '') throw new TestkitError(`Invalid KAP ready line: ${line}`);
  const origin = new URL(ready.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || ready.ws_url !== `ws://${origin.host}/api/v1/ws`) {
    throw new TestkitError(`The KAP ready line does not describe a loopback server: ${line}`);
  }
  return { origin: origin.origin, token: ready.token };
}
