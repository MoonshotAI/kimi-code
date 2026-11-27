import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { kimiCliCommand, repoPath, TIMEOUTS, until } from '@moonshot-ai/testkit/fixtures';
import { chromium, test, type BrowserContext, type Page } from '@playwright/test';

import { StartupFailure, type Diagnostic, type ReopenState, type SurfaceDriver, type SurfaceLaunch, type WindowSize } from '../support/verbs';
import { productEnv } from './environment';
import { offlineStubs } from './offline';
import { OFFLINE_NAMES, PageDriver, reasonOf, WELCOME_DIALOG } from './page-driver';
import { TerminalProcess } from './terminal-process';
import { dynamicPorts, workerWebPorts } from './web-port';

const ADDRESS = /^\s*Local:\s+(http:\/\/127\.0\.0\.1:(\d+)\/#token=\S+)\s*$/;
const SERVER_TERMINAL = { columns: 400, rows: 50 };
const VIEWPORTS: Readonly<Record<WindowSize, { readonly width: number; readonly height: number }>> = {
  normal: { width: 1440, height: 900 },
  narrow: { width: 390, height: 844 },
};

interface WebLaunch {
  readonly size: WindowSize;
  readonly root: string;
  readonly workspace: string;
  readonly port: string;
  readonly launch: number;
  readonly lastPrompt: string | undefined;
}

class WebDriver extends PageDriver {
  private readonly server: TerminalProcess;
  private readonly workspace: string;
  private readonly port: string;
  private readonly reopening: boolean;
  private readonly lastPrompt: string | undefined;
  private open = true;
  private size: WindowSize;

  constructor(server: TerminalProcess, context: BrowserContext, { size, root, workspace, port, launch, lastPrompt }: WebLaunch) {
    super(context, root, 'web', launch);
    this.size = size;
    this.server = server;
    this.workspace = workspace;
    this.port = port;
    this.reopening = launch > 1;
    this.lastPrompt = lastPrompt;
  }

  reopenState(): ReopenState {
    const { low, high } = dynamicPorts();
    const port = Number(this.port);
    if (port >= low && port <= high) {
      throw new Error(
        `restart() would reopen the web UI on port ${this.port}, inside the range ${low}–${high} this machine hands to any process that asks for a free port, so another process can take it while the product is closed and the page could not come back on the same origin.`,
      );
    }
    return { port: this.port, size: this.size };
  }

  async resize(size: WindowSize): Promise<void> {
    const { width, height } = VIEWPORTS[this.size];
    if (size === this.size) throw new Error(`resize() found the window already ${size} (${width}×${height}); resize it to the other size.`);
    await this.resizeWindow(VIEWPORTS[size]);
    this.size = size;
  }

  async ready(address: string): Promise<void> {
    let starting = true;
    const crashed = this.server.closed.then(() => {
      if (starting) throw new Error('The web server exited while the page was getting ready.');
    });
    try {
      await Promise.race([this.prepare(address), crashed]);
    } finally {
      starting = false;
    }
  }

  async startupFailure(error: unknown): Promise<Error> {
    const page = await this.readPage();
    const diagnostics = await this.diagnostics();
    const state = this.describe();
    await this.kill();
    return new StartupFailure(error, diagnostics, [`The Web interface did not become ready: ${reasonOf(error)}`, page, state].join('\n'));
  }

  async close(): Promise<void> {
    if (this.server.exited) throw new Error(`The web server exited before the scenario closed it.\n${this.describe()}`);
    await this.leave();
    await this.shutDown();
  }

  async quitDuringTurn(): Promise<void> {
    if (this.server.exited) throw new Error(`The web server exited before the user quit it.\n${this.describe()}`);
    await this.leaveDuringTurn();
    await this.shutDown();
  }

  private async shutDown(): Promise<void> {
    this.open = false;
    await this.context.close();
    if (this.server.exited) throw new Error(`The web server exited while the browser was closing.\n${this.describe()}`);
    this.server.interrupt();
    let exit;
    try {
      exit = await until('the web server to exit', () => this.server.exit(), { timeoutMs: TIMEOUTS.wait });
    } catch (cause) {
      throw new Error(`The web server did not exit after the user pressed Ctrl+C in its terminal.\n${this.describe()}`, { cause });
    }
    const problems = [
      ...(exit.code === 0 ? [] : [`The web server exited with code ${String(exit.code)} and signal ${String(exit.signal)} after the user pressed Ctrl+C in its terminal.`]),
      ...this.pageProblems(),
    ];
    if (problems.length > 0) throw new Error(`${problems.join('\n')}\n${this.describe()}`);
  }

  async kill(): Promise<void> {
    this.open = false;
    await this.context.close().catch(() => undefined);
    if (!this.server.exited) await this.server.forceKill();
  }

  async networkViolations(): Promise<readonly string[]> {
    return [...(await this.server.networkViolations()), ...this.beyond];
  }

  async diagnostics(): Promise<readonly Diagnostic[]> {
    if (this.open) await this.readPage();
    await this.saveTrace();
    return [...this.pageDiagnostics(), { name: 'web-session', body: this.describe() }];
  }

  private async prepare(address: string): Promise<void> {
    await this.startTrace();
    const page = await this.context.newPage();
    this.show(page, this.workspace, () => Promise.resolve(page));
    await page.goto(address, { timeout: TIMEOUTS.server });
    if (this.reopening) {
      await page.getByRole('status', { name: 'Connecting…' }).first().waitFor({ state: 'hidden', timeout: TIMEOUTS.server });
      await page.getByRole('combobox', { name: 'Message input' }).waitFor({ state: 'visible', timeout: TIMEOUTS.server });
      await this.awaitResumed(this.lastPrompt);
      return;
    }
    const welcome = page.getByRole('dialog', { name: WELCOME_DIALOG });
    await welcome.waitFor({ state: 'visible', timeout: TIMEOUTS.server });
    await welcome.getByRole('button', { name: 'Skip', exact: true }).click({ timeout: TIMEOUTS.wait });
    await welcome.waitFor({ state: 'hidden', timeout: TIMEOUTS.server });
    await page.getByRole('status', { name: 'Connecting…' }).first().waitFor({ state: 'hidden', timeout: TIMEOUTS.server });
    await this.addProject(page);
    await page.getByRole('button', { name: basename(this.workspace), exact: true }).waitFor({ state: 'visible', timeout: TIMEOUTS.server });
    await page.getByRole('combobox', { name: 'Message input' }).waitFor({ state: 'visible', timeout: TIMEOUTS.server });
  }

  private async addProject(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'New Project', exact: true }).click({ timeout: TIMEOUTS.wait });
    const project = page.getByRole('dialog', { name: 'New project' });
    await project.getByRole('button', { name: 'Click to add folders you can read and write' }).click({ timeout: TIMEOUTS.wait });
    const folders = page.getByRole('dialog', { name: 'Add project' });
    const path = folders.getByRole('combobox', { name: 'Path or folder search' });
    await until('the folder picker to show where it starts', async () => ((await path.inputValue({ timeout: TIMEOUTS.wait })) === '' ? undefined : true), {
      timeoutMs: TIMEOUTS.server,
    });
    await path.fill(this.workspace, { timeout: TIMEOUTS.wait });
    await folders.getByRole('button', { name: 'Add', exact: true }).click({ timeout: TIMEOUTS.wait });
    await folders.getByRole('button', { name: 'Add folder (1)', exact: true }).click({ timeout: TIMEOUTS.wait });
    await folders.waitFor({ state: 'hidden', timeout: TIMEOUTS.server });
    await project.getByRole('button', { name: 'Create', exact: true }).click({ timeout: TIMEOUTS.wait });
    await project.waitFor({ state: 'hidden', timeout: TIMEOUTS.server });
  }

  private describe(): string {
    return [this.server.describe(), this.describePage()].join('\n');
  }
}

export async function startWeb({ home, reopen }: SurfaceLaunch): Promise<SurfaceDriver<'web'>> {
  const assets = repoPath('apps', 'kimi-code', 'web-dist', 'index.html');
  if (!existsSync(assets)) throw new Error(`${assets} does not exist; build the web assets first with "pnpm sync:web".`);
  const ownPorts = workerWebPorts(test.info().parallelIndex);
  const server = await TerminalProcess.start({
    label: 'kimi web',
    command: kimiCliCommand(),
    args: ['web', '--port', reopen?.state.port ?? String(ownPorts.low), '--no-open', '--no-daemon'],
    cwd: home.workspace,
    env: productEnv(home, { FORCE_COLOR: '0' }),
    logDir: home.root,
    fetchStubs: offlineStubs(),
    ...SERVER_TERMINAL,
  });
  let context: BrowserContext | undefined;
  let driver: WebDriver | undefined;
  try {
    const line = await server.waitForLine((text) => ADDRESS.test(text), 'the address of the web interface');
    const [, address, port] = ADDRESS.exec(line) ?? [];
    if (address === undefined || port === undefined) throw new Error(`The web server printed an address the driver could not read: ${line}`);
    const wanted = reopen?.state.port;
    if (wanted !== undefined && port !== wanted) {
      throw new Error(
        `The restarted web server listens on port ${port} instead of ${wanted}, so the page would open on a different origin and lose the browser state a returning user keeps. Another process probably took the port.`,
      );
    }
    if (Number(port) < ownPorts.low || Number(port) > ownPorts.high) {
      throw new Error(
        `The web server listens on port ${port}, outside ports ${ownPorts.low}–${ownPorts.high} that this worker keeps: other programs hold all of them, and a port past them belongs to another worker, which could take it while this one restarts.`,
      );
    }
    const size = reopen?.state.size ?? 'normal';
    context = await chromium.launchPersistentContext(join(home.root, 'web-profile'), {
      args: [OFFLINE_NAMES],
      headless: process.env['E2E_HEADED'] !== '1',
      timeout: TIMEOUTS.server,
      locale: 'en-US',
      viewport: VIEWPORTS[size],
    });
    driver = new WebDriver(server, context, { size, root: home.root, workspace: home.workspace, port, launch: reopen?.launch ?? 1, lastPrompt: reopen?.lastPrompt });
    await driver.ready(address);
    return driver;
  } catch (error) {
    if (driver !== undefined) throw await driver.startupFailure(error);
    const state = server.describe();
    await context?.close().catch(() => undefined);
    if (!server.exited) await server.forceKill();
    throw new StartupFailure(error, [{ name: 'web-server', body: state }], `${reasonOf(error)}\n${state}`);
  }
}
