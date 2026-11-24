import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import { kimiCliCommand, kimiCliEnv, repoPath, TestProcess, TIMEOUTS, until } from '@moonshot-ai/testkit/fixtures';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

import type { Diagnostic, SurfaceDriver, SurfaceLaunch } from '../support/verbs';
import { offlineStubs } from './offline';
import { OFFLINE_NAMES, PageDriver, reasonOf } from './page-driver';

const ADDRESS = /^\s*Local:\s+(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)\s*$/;
const VIEWPORT = { width: 1440, height: 900 };

class WebDriver extends PageDriver {
  private readonly server: TestProcess;
  private readonly browser: Browser;
  private readonly workspace: string;
  private open = true;

  constructor(server: TestProcess, browser: Browser, context: BrowserContext, root: string, workspace: string) {
    super(context, root, 'web');
    this.server = server;
    this.browser = browser;
    this.workspace = workspace;
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
    await this.saveTrace();
    await this.kill();
    return new Error(
      [
        `The Web interface did not become ready: ${reasonOf(error)}`,
        page,
        this.describe(),
        ...(existsSync(this.trace) ? [`A trace of the start-up is at ${this.trace}`] : []),
      ].join('\n'),
      { cause: error },
    );
  }

  async close(): Promise<void> {
    if (this.server.exited) throw new Error(`The web server exited before the scenario closed it.\n${this.describe()}`);
    await this.leave();
    this.open = false;
    await this.context.close();
    await this.browser.close();
    if (this.server.exited) throw new Error(`The web server exited while the browser was closing.\n${this.describe()}`);
    process.kill(-this.server.pid, 'SIGINT');
    let exit;
    try {
      exit = await until('the web server to exit', () => this.server.exit(), { timeoutMs: TIMEOUTS.wait });
    } catch (cause) {
      throw new Error(`The web server did not exit after Ctrl+C.\n${this.describe()}`, { cause });
    }
    const problems = [
      ...(exit.code === 0 ? [] : [`The web server exited with code ${String(exit.code)} and signal ${String(exit.signal)} after Ctrl+C.`]),
      ...this.pageProblems(),
    ];
    if (problems.length > 0) throw new Error(`${problems.join('\n')}\n${this.describe()}`);
  }

  async kill(): Promise<void> {
    this.open = false;
    await this.browser.close().catch(() => undefined);
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
    this.show(page, this.workspace);
    await page.goto(address, { timeout: TIMEOUTS.server });
    const welcome = page.getByRole('dialog', { name: 'Welcome to Kimi Code' });
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
    return [this.server.describe(), `stdout:\n${this.server.stdoutTail() === '' ? '(empty)' : this.server.stdoutTail()}`, this.describePage()].join('\n');
  }
}

export async function startWeb({ home }: SurfaceLaunch): Promise<SurfaceDriver> {
  if (process.platform === 'win32') throw new Error('The Web surface stops its server with Ctrl+C, which Windows cannot deliver to a child process; Windows is not supported yet.');
  const assets = repoPath('apps', 'kimi-code', 'dist-web', 'index.html');
  if (!existsSync(assets)) throw new Error(`${assets} does not exist; build the web assets first with "pnpm sync:web".`);
  const server = TestProcess.start({
    label: 'kimi web',
    command: kimiCliCommand(),
    args: ['web', '--port', '0', '--no-open'],
    cwd: home.workspace,
    env: kimiCliEnv(home, { FORCE_COLOR: '0' }),
    logDir: home.root,
    fetchStubs: offlineStubs(),
  });
  let browser: Browser | undefined;
  let driver: WebDriver | undefined;
  try {
    const line = await server.waitForLine((text) => ADDRESS.test(text), { timeoutMs: TIMEOUTS.server, description: 'the address of the web interface' });
    const address = ADDRESS.exec(line)?.[1];
    if (address === undefined) throw new Error(`The web server printed an address the driver could not read: ${line}`);
    browser = await chromium.launch({ args: [OFFLINE_NAMES], headless: process.env['E2E_HEADED'] !== '1', timeout: TIMEOUTS.server });
    const context = await browser.newContext({ locale: 'en-US', viewport: VIEWPORT });
    driver = new WebDriver(server, browser, context, home.root, home.workspace);
    await driver.ready(address);
    return driver;
  } catch (error) {
    if (driver !== undefined) throw await driver.startupFailure(error);
    await browser?.close().catch(() => undefined);
    if (!server.exited) await server.forceKill();
    throw error;
  }
}
