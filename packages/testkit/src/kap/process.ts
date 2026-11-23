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

export type KapStopMode = 'close' | 'crash';

interface ReadyLine {
  readonly origin: string;
  readonly token: string;
}

interface Running {
  child: TestProcess;
  ready: ReadyLine;
  stopping: Promise<void> | undefined;
}

export class KapProcess extends KapClient {
  private readonly running: Running;
  private readonly options: StartKapProcessOptions;

  private constructor(running: Running, options: StartKapProcessOptions) {
    super({ origin: () => running.ready.origin, token: () => running.ready.token }, { workspace: options.home.workspace, onFrame: options.onFrame });
    this.running = running;
    this.options = options;
  }

  static async start(options: StartKapProcessOptions): Promise<KapProcess> {
    const { child, ready } = await launch(options, '0');
    return new KapProcess({ child, ready, stopping: undefined }, options);
  }

  get pid(): number {
    return this.running.child.pid;
  }

  describe(): string {
    return this.running.child.describe();
  }

  close(): Promise<void> {
    this.running.stopping ??= this.stop('close');
    return this.running.stopping;
  }

  crash(): Promise<void> {
    this.running.stopping ??= this.stop('crash');
    return this.running.stopping;
  }

  async restart(mode: KapStopMode = 'close'): Promise<void> {
    if (this.running.stopping !== undefined) throw new TestkitError('The KAP server was already stopped; start a new KapProcess instead of restarting this one');
    const previous = this.running.ready;
    await (mode === 'crash' ? this.crash() : this.close());
    const { child, ready } = await launch(this.options, new URL(previous.origin).port);
    if (ready.origin !== previous.origin) {
      await child.forceKill();
      throw new TestkitError(`The restarted KAP server listens on ${ready.origin} instead of ${previous.origin}`);
    }
    Object.assign(this.running, { child, ready, stopping: undefined });
  }

  private async stop(mode: KapStopMode): Promise<void> {
    const child = this.running.child;
    const exitedEarly = child.exited;
    try {
      const exit = mode === 'crash' ? await child.forceKill() : await this.shutdown(child);
      await this.closeSockets();
      const blocked = await child.networkViolations();
      if (blocked.length > 0) throw new TestkitError(`The KAP server tried to reach non-loopback addresses: ${blocked.join(', ')}`);
      const expected = mode === 'crash' ? killedByTest(exit) : exit.code === 0;
      if (exitedEarly || !expected) throw new TestkitError(`The KAP server ended unexpectedly while the test asked it to ${mode}`);
    } catch (cause) {
      await child.forceKill();
      await this.closeSockets();
      throw new TestkitError(`Could not ${mode} the KAP server\n${child.describe()}`, { cause });
    }
  }

  private async shutdown(child: TestProcess): Promise<ProcessExit> {
    await this.closeSockets();
    await this.rest.request('/api/v1/shutdown', { method: 'POST', body: {}, signal: AbortSignal.timeout(TIMEOUTS.wait) });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void child.forceKill();
    }, TIMEOUTS.server);
    try {
      const exit = await child.closed;
      if (timedOut) throw new TestkitError(`The KAP server did not exit within ${TIMEOUTS.server} ms after the shutdown request`);
      return exit;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function launch(options: StartKapProcessOptions, port: string): Promise<{ child: TestProcess; ready: ReadyLine }> {
  const child = TestProcess.start({
    label: 'KAP server',
    command: options.command ?? kimiCliCommand(),
    args: ['web', '--port', port, '--json'],
    cwd: options.home.workspace,
    env: kimiCliEnv(options.home, options.env),
    logDir: options.home.root,
    fetchStubs: [...kimiServiceStubs(), ...(options.fetchStubs ?? [])],
  });
  try {
    const line = await child.waitForLine((text) => text.trimStart().startsWith('{'), { description: 'the KAP ready line' });
    return { child, ready: readyLineOf(line) };
  } catch (cause) {
    await child.forceKill();
    throw new TestkitError(`The KAP server failed to start\n${child.describe()}`, { cause });
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
