import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { killProcessTree, kimiCliEnv, NETWORK_GUARD_PRELOAD, networkGuardEnv, readNetworkViolations, repoPath, TIMEOUTS, until } from '@moonshot-ai/testkit/fixtures';
import { _electron, type ElectronApplication } from '@playwright/test';

import type { Diagnostic, SurfaceDriver, SurfaceLaunch, ToolExpectation } from '../support/verbs';
import { offlineStubs } from './offline';
import { RendererSurface } from './renderer';

const MAIN_PAGE = 'app://renderer/';
const AUXILIARY_PAGES = /^app:\/\/renderer\/(?:browser-overlay|browser-control|screenshot|pin|capture-host)\b/;
const LOCAL_SCHEMES = new Set(['app:', 'file:', 'data:', 'blob:', 'about:', 'devtools:', 'chrome:']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const OFFLINE_RENDERER = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1';
const OUTPUT_TAIL = 64 * 1024;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reachesBeyondThisMachine(url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return true;
  }
  return !LOCAL_SCHEMES.has(target.protocol) && !LOOPBACK_HOSTS.has(target.hostname);
}

class DesktopDriver implements SurfaceDriver {
  private readonly app: ElectronApplication;
  private readonly workspace: string;
  private readonly networkLog: string;
  private readonly trace: string;
  private readonly beyond: string[] = [];
  private readonly pageErrors: string[] = [];
  private output = '';
  private exit: { readonly code: number | null; readonly signal: string | null } | undefined;
  private tracing = false;
  private renderer: RendererSurface | undefined;
  private lastPage = 'The main window never became ready.';

  constructor(app: ElectronApplication, root: string, workspace: string, networkLog: string) {
    this.app = app;
    this.workspace = workspace;
    this.networkLog = networkLog;
    this.trace = join(root, 'desktop-trace.zip');
    const collect = (chunk: Buffer): void => {
      this.output = (this.output + chunk.toString()).slice(-OUTPUT_TAIL);
    };
    app.process().stdout?.on('data', collect);
    app.process().stderr?.on('data', collect);
    app.process().once('exit', (code, signal) => {
      this.exit = { code, signal };
    });
    app.context().on('request', (request) => {
      if (reachesBeyondThisMachine(request.url())) this.beyond.push(`${request.method()} ${request.url()}`);
    });
    app.context().on('weberror', (event) => {
      const error = event.error();
      this.pageErrors.push(error.stack ?? error.message);
    });
  }

  async ready(): Promise<void> {
    await this.app.context().tracing.start({ screenshots: true, snapshots: true });
    this.tracing = true;
    const page = await this.wait('the main window to open', () =>
      this.app.windows().find((candidate) => candidate.url().startsWith(MAIN_PAGE) && !AUXILIARY_PAGES.test(candidate.url())),
    );
    this.renderer = new RendererSurface(page, this.workspace);
    await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUTS.server });
    const welcome = page.getByRole('dialog', { name: 'Welcome to Kimi Code' });
    await welcome.waitFor({ state: 'visible', timeout: TIMEOUTS.server });
    await welcome.getByRole('button', { name: 'Skip', exact: true }).click({ timeout: TIMEOUTS.wait });
    await welcome.waitFor({ state: 'hidden', timeout: TIMEOUTS.server });
    await page.getByRole('button', { name: basename(this.workspace), exact: true }).waitFor({ state: 'visible', timeout: TIMEOUTS.server });
    await page.getByRole('status', { name: 'Connecting…' }).first().waitFor({ state: 'hidden', timeout: TIMEOUTS.server });
    await page.getByRole('combobox', { name: 'Message input' }).waitFor({ state: 'visible', timeout: TIMEOUTS.server });
  }

  async startupFailure(error: unknown): Promise<Error> {
    const page = this.renderer === undefined ? this.lastPage : await this.renderer.describe();
    const traced = await this.saveTrace();
    await this.kill();
    return new Error(
      [
        `The Desktop app did not become ready: ${reasonOf(error)}`,
        page,
        this.describe(),
        ...(traced ? [`A trace of the start-up is at ${this.trace}`] : []),
      ].join('\n'),
      { cause: error },
    );
  }

  send(text: string): Promise<void> {
    return this.window().send(text);
  }

  approve(): Promise<void> {
    return this.window().approve();
  }

  reject(): Promise<void> {
    return this.window().reject();
  }

  stop(): Promise<void> {
    return this.window().stop();
  }

  waitIdle(): Promise<void> {
    return this.window().waitIdle();
  }

  expectTool(expectation: ToolExpectation): Promise<void> {
    return this.window().expectTool(expectation);
  }

  expectReply(text: string): Promise<void> {
    return this.window().expectReply(text);
  }

  async close(): Promise<void> {
    if (this.exit !== undefined) throw new Error(`The Desktop app exited before the scenario closed it.\n${this.describe()}`);
    this.lastPage = await this.window().describe();
    if (!(await this.window().idle())) {
      throw new Error(`The scenario ended while a turn was running or an approval was pending; end it with waitIdle().\n${this.lastPage}`);
    }
    await this.saveTrace();
    const closing = this.app.close().then(
      () => undefined,
      (error: unknown) => reasonOf(error),
    );
    let exit;
    try {
      exit = await until('the Desktop app to exit', () => this.exit, { timeoutMs: TIMEOUTS.server });
    } catch (cause) {
      throw new Error(`The Desktop app did not exit after it was asked to quit.\n${this.describe()}`, { cause });
    }
    const refused = await closing;
    const problems = [
      ...(exit.code === 0 ? [] : [`The Desktop app exited with code ${String(exit.code)} and signal ${String(exit.signal)}.`]),
      ...(refused === undefined ? [] : [`Closing the Desktop app reported: ${refused}`]),
      ...(this.pageErrors.length === 0 ? [] : [`The window reported ${this.pageErrors.length} uncaught error(s):\n${this.pageErrors.join('\n')}`]),
    ];
    if (problems.length > 0) throw new Error(`${problems.join('\n')}\n${this.describe()}`);
  }

  async kill(): Promise<void> {
    if (this.exit !== undefined) return;
    const pid = this.app.process().pid;
    if (pid !== undefined) killProcessTree(pid);
    try {
      await until('the Desktop app to exit after it was killed', () => this.exit, { timeoutMs: TIMEOUTS.wait });
    } catch {
      this.output = `${this.output}\nThe Desktop app did not exit after it was killed.`;
    }
  }

  async networkViolations(): Promise<readonly string[]> {
    return [...(await readNetworkViolations(this.networkLog, 'The Desktop main process')), ...this.beyond];
  }

  async diagnostics(): Promise<readonly Diagnostic[]> {
    if (this.renderer !== undefined && this.exit === undefined) this.lastPage = await this.renderer.describe();
    await this.saveTrace();
    return [
      ...(existsSync(this.trace) ? [{ name: 'desktop-trace', path: this.trace }] : []),
      { name: 'desktop-page', body: this.lastPage },
      { name: 'desktop-session', body: this.describe() },
    ];
  }

  private window(): RendererSurface {
    if (this.renderer === undefined) throw new Error('The Desktop window is not ready.');
    return this.renderer;
  }

  private async saveTrace(): Promise<boolean> {
    if (!this.tracing) return existsSync(this.trace);
    this.tracing = false;
    try {
      await this.app.context().tracing.stop({ path: this.trace });
      return true;
    } catch (error) {
      this.output = `${this.output}\nThe trace could not be saved: ${reasonOf(error)}`;
      return false;
    }
  }

  private async wait<T>(label: string, check: () => T | undefined): Promise<Exclude<T, undefined>> {
    let outcome: { readonly value: Exclude<T, undefined> } | { readonly exited: true };
    try {
      outcome = await until(
        label,
        () => {
          const value = check();
          if (value !== undefined) return { value: value as Exclude<T, undefined> };
          return this.exit === undefined ? undefined : { exited: true as const };
        },
        { timeoutMs: TIMEOUTS.server },
      );
    } catch (cause) {
      throw new Error(`${reasonOf(cause)}\n${this.describe()}`, { cause });
    }
    if ('exited' in outcome) throw new Error(`The Desktop app exited while the test waited for ${label}.\n${this.describe()}`);
    return outcome.value;
  }

  private describe(): string {
    return [
      this.exit === undefined ? 'The Desktop app is still running.' : `The Desktop app exited with code ${String(this.exit.code)} and signal ${String(this.exit.signal)}.`,
      `Windows: ${this.exit === undefined ? this.app.windows().map((page) => page.url()).join(', ') : '(closed)'}`,
      `Requests beyond this machine: ${JSON.stringify(this.beyond)}`,
      `Uncaught errors in the window: ${JSON.stringify(this.pageErrors)}`,
      `Output:\n${this.output === '' ? '(empty)' : this.output}`,
    ].join('\n');
  }
}

export async function startDesktop({ home }: SurfaceLaunch): Promise<SurfaceDriver> {
  const desktop = repoPath('apps', 'desktop');
  for (const built of [join(desktop, 'out', 'main.cjs'), join(desktop, 'desktop-dist', 'index.html')]) {
    if (!existsSync(built)) throw new Error(`${built} does not exist; build the Desktop app first with "pnpm --filter kimi-code-app run build".`);
  }
  const networkLog = join(home.root, 'desktop-network.log');
  const app = await _electron.launch({
    args: [
      '-r',
      fileURLToPath(NETWORK_GUARD_PRELOAD),
      desktop,
      `--user-data-dir=${join(home.root, 'user-data')}`,
      '--lang=en-US',
      `--workspace=${home.workspace}`,
      OFFLINE_RENDERER,
    ],
    cwd: home.workspace,
    env: {
      ...kimiCliEnv(home, {
        ELECTRON_RUN_AS_NODE: undefined,
        LANG: 'en_US.UTF-8',
        KIMI_DESKTOP_E2E: process.env['E2E_HEADED'] === '1' ? '1' : 'quiet',
        KIMI_DESKTOP_NO_SHELL_ENV: '1',
      }),
      ...networkGuardEnv(networkLog, offlineStubs()),
    },
    timeout: TIMEOUTS.server,
  });
  const driver = new DesktopDriver(app, home.root, home.workspace, networkLog);
  try {
    await driver.ready();
  } catch (error) {
    throw await driver.startupFailure(error);
  }
  return driver;
}
