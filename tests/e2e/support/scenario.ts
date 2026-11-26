import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  contentDigest,
  createTestHome,
  directoryChanges,
  mergeKimiConfig,
  snapshotDirectory,
  startFakeMcpHttpServer,
  writeKimiConfig,
  writeMcpConfig,
  type DirectorySnapshot,
  type FakeMcpHttpServer,
  type FakeMcpTool,
  type KimiConfig,
  type McpRemoteServerEntry,
  type TestHome,
  until,
} from '@moonshot-ai/testkit/fixtures';
import { fakeModelConfig, startFakeModel, type FakeModel, type FakeProviderOptions } from '@moonshot-ai/testkit/model';
import { expect, test as base, type TestInfo } from '@playwright/test';

import { startAcp } from '../surfaces/acp';
import { startDesktop } from '../surfaces/desktop';
import { clockFileOf } from '../surfaces/environment';
import { startTui } from '../surfaces/tui';
import { startWeb } from '../surfaces/web';
import { CLOCK_TITLE, DISK_TITLES, MCP_TITLES, STEP_TITLES } from './steps';
import {
  absenceReason,
  StartupFailure,
  SURFACES,
  unavailableReason,
  VARIANTS,
  VERB_NAMES,
  verbOn,
  verbSpec,
  wantedChanges,
  wantedOutput,
  type Actions,
  type Platform,
  type Variant,
  type ApprovalExpectation,
  type Diagnostic,
  type Frame,
  type ProductOn,
  type Surface,
  type SurfaceDriver,
  type EditorMcpServer,
  type SurfaceLaunch,
  type SurfacesOf,
  type ToolExpectation,
  type Verb,
} from './verbs';

export { expect };

export interface SurfaceOptions {
  surface: Surface | undefined;
  variant: Variant | undefined;
}

export type ScenarioProvider = Pick<FakeProviderOptions, 'type' | 'capabilities' | 'maxContextSize'>;

export interface ScenarioMcpServer {
  readonly tools: readonly FakeMcpTool[];
  readonly deferred?: boolean;
  readonly from?: 'config' | 'editor';
}

export interface McpServerHandle {
  addTool(tool: FakeMcpTool): Promise<void>;
  updateTool(name: string, change: Partial<Omit<FakeMcpTool, 'name'>>): Promise<void>;
  removeTool(name: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ScenarioOptions {
  readonly workspace?: Readonly<Record<string, string>>;
  readonly clock?: string;
  readonly provider?: ScenarioProvider;
  readonly config?: KimiConfig;
  readonly mcp?: Readonly<Record<string, ScenarioMcpServer>>;
  readonly workspaceTrust?: SurfaceLaunch['workspaceTrust'];
  readonly except?: Readonly<Partial<Record<Surface, string>>>;
  readonly onlyOn?: readonly Surface[];
  readonly reason?: string;
  readonly exceptPlatforms?: Readonly<Partial<Record<Platform, string>>>;
  readonly exceptVariants?: Readonly<Partial<Record<Variant, string>>>;
}

export interface Workspace {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  expectFile(path: string, content: string): Promise<void>;
  expectMissing(path: string): Promise<void>;
}

export interface ScenarioContext<S extends Surface> {
  readonly product: ProductOn<S>;
  readonly model: FakeModel;
  readonly workspace: Workspace;
  readonly mcp: (name: string) => McpServerHandle;
  readonly clock: (time: string) => Promise<void>;
}

export type ScenarioBody<S extends Surface> = (context: ScenarioContext<S>) => Promise<void>;

interface RunningContext {
  readonly product: Actions;
  readonly model: FakeModel;
  readonly workspace: Workspace;
  readonly mcp: (name: string) => McpServerHandle;
  readonly clock: (time: string) => Promise<void>;
}

type RunningBody = (context: RunningContext) => Promise<void>;

export type RunsOn<O extends ScenarioOptions> = O extends { readonly onlyOn: readonly (infer S)[] }
  ? Extract<S, Surface>
  : O extends { readonly except: infer E }
    ? Exclude<Surface, keyof E>
    : Surface;

export interface SelfTestCase<S extends Surface> extends ScenarioOptions {
  readonly run: ScenarioBody<S>;
}

export type SelfTestCases<S extends Surface> = Readonly<Record<string, SelfTestCase<S>>>;

export interface SelfTestSuite<S extends Surface> {
  readonly positive: SelfTestCases<S>;
  readonly negative: SelfTestCases<S>;
}

type FramePolicy = 'every-step' | 'on-failure';

const SELF_TEST_KINDS = ['positive', 'negative'] as const;
const SELF_TEST_DIRECTORY = fileURLToPath(new URL('../self-test/', import.meta.url));

function startSurface(surface: Surface, launch: SurfaceLaunch): Promise<SurfaceDriver<Surface>> {
  switch (surface) {
    case 'tui':
      return startTui(launch);
    case 'acp':
      return startAcp(launch);
    case 'desktop':
      return startDesktop(launch);
    case 'web':
      return startWeb(launch);
  }
}

function assertOutsideGitWorkTree(workspace: string): void {
  for (let directory = workspace; ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) {
      throw new Error(
        `The scenario workspace ${workspace} is inside the git work tree at ${directory}. ` +
          'On POSIX the product approves Edit and Write automatically inside a git work tree, so approval scenarios would hang. ' +
          'Point TMPDIR at a directory outside every repository.',
      );
    }
    if (dirname(directory) === directory) return;
  }
}

function workspaceKey(path: string): string {
  const normalized = normalize(path);
  if (path === '' || isAbsolute(path) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`A workspace path must be relative and stay inside the workspace, got ${JSON.stringify(path)}`);
  }
  return normalized.split(sep).join('/');
}

async function seedWorkspace(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, workspaceKey(path));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function promptCheck(verb: 'send' | 'queue' | 'steer'): (text: string) => void {
  return (text) => {
    if (!/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u.test(text) || text !== text.trim()) {
      throw new Error(`${verb}() takes one line of printable text without surrounding spaces, got ${JSON.stringify(text)}`);
    }
    if (text.endsWith('\\')) {
      throw new Error(`${verb}() cannot end with a backslash: the product reads a backslash before Enter as a line break and never submits. Got ${JSON.stringify(text)}`);
    }
    if (/^[/!@]/.test(text)) {
      throw new Error(
        `${verb}() cannot take a prompt that starts with "/", "!" or "@": the product reads those as a slash command, shell mode or a file mention. Got ${JSON.stringify(text)}`,
      );
    }
  };
}

function assertToolExpectation(expectation: ToolExpectation): void {
  const asked: { readonly name: string; readonly status: string; readonly output?: unknown } = expectation;
  if (asked.name !== 'Bash' && (asked.status === 'running' || asked.output !== undefined)) {
    throw new Error(`expectTool() can expect a running tool, or the output of a tool, only for Bash, not for ${asked.name}.`);
  }
  if (asked.status === 'rejected' && asked.output !== undefined) {
    throw new Error('expectTool() cannot expect output of a rejected command: it never ran.');
  }
  if (asked.status === 'running' && asked.output === undefined) {
    throw new Error(
      'expectTool() can expect a running command only together with output it has printed: until a command prints, the surfaces do not agree on whether it is running or still waiting for approval.',
    );
  }
  const output = wantedOutput(expectation);
  if (output === undefined) return;
  if (!/^[ -~]+$/.test(output) || output !== output.trim()) {
    throw new Error(`expectTool() takes the output as one line of printable ASCII without surrounding spaces, got ${JSON.stringify(output)}`);
  }
  if (expectation.target.includes(output)) {
    throw new Error(
      `expectTool() cannot tell the output ${JSON.stringify(output)} from the command ${JSON.stringify(expectation.target)}: it is part of the command, and the interface shows the command next to its output. Make the command print text that it does not contain.`,
    );
  }
}

function lineCheck(verb: 'expectError' | 'expectAbsent' | 'rejectWithFeedback' | 'answer' | 'answerOther'): (text: string) => void {
  return (text) => {
    if (!/^[ -~]+$/.test(text) || text !== text.trim()) {
      throw new Error(`${verb}() takes one line of printable ASCII without surrounding spaces, got ${JSON.stringify(text)}`);
    }
  };
}

function assertApprovalExpectation(expectation: ApprovalExpectation): void {
  const { name, target } = expectation;
  if (!/^[ -~]+$/.test(target) || target !== target.trim()) {
    throw new Error(`expectApproval() takes the target as one line of printable ASCII without surrounding spaces, got ${JSON.stringify(target)}`);
  }
  if (name !== 'Bash' && workspaceKey(target) !== target) {
    throw new Error(`expectApproval() takes the file as a normalized path relative to the workspace, like "notes/a.txt", got ${JSON.stringify(target)}`);
  }
  const { added, removed } = wantedChanges(expectation);
  for (const line of [...added, ...removed]) {
    if (!/^[ -~]+$/.test(line) || line !== line.trim()) {
      throw new Error(`expectApproval() takes each changed line as one line of printable ASCII without surrounding spaces, got ${JSON.stringify(line)}`);
    }
  }
}

const PRECHECKS: { readonly [V in Verb]?: (...args: Parameters<Actions[V]>) => void } = {
  send: promptCheck('send'),
  queue: promptCheck('queue'),
  steer: promptCheck('steer'),
  expectTool: assertToolExpectation,
  rejectWithFeedback: lineCheck('rejectWithFeedback'),
  answer: lineCheck('answer'),
  answerOther: lineCheck('answerOther'),
  expectApproval: assertApprovalExpectation,
  expectError: lineCheck('expectError'),
  expectAbsent: lineCheck('expectAbsent'),
};


function timeOf(time: string): string {
  if (Number.isNaN(Date.parse(time))) throw new Error(`A clock time must be an ISO-8601 time like 2030-01-01T12:00:00Z, got ${JSON.stringify(time)}`);
  return time;
}

function problemOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RunningProduct {
  readonly home: TestHome;
  readonly model: FakeModel;
  readonly driver: SurfaceDriver<Surface>;
}

class ScenarioSession {
  private readonly surface: Surface;
  private readonly variant: Variant | undefined;
  private readonly declared = new Map<string, string | undefined>();
  private home: TestHome | undefined;
  private model: FakeModel | undefined;
  private readonly mcpServers = new Map<string, FakeMcpHttpServer>();
  private readonly editorMcpServers: EditorMcpServer[] = [];
  private driver: SurfaceDriver<Surface> | undefined;
  private baseline: DirectorySnapshot | undefined;
  private interfaceChecks = 0;
  private frames: FramePolicy = 'on-failure';
  private testInfo: TestInfo | undefined;
  private steps = 0;
  private failedStep: string | undefined;
  private launches = 1;
  private lastPrompt: string | undefined;
  private sessions = 1;
  private workspaceTrust: SurfaceLaunch['workspaceTrust'];
  private readonly earlierDiagnostics: Diagnostic[] = [];
  private readonly performed = new Set<Verb>();
  private exceptPlatforms: readonly string[] = [];

  constructor(surface: Surface, variant: Variant | undefined) {
    this.surface = surface;
    this.variant = variant;
  }

  async start(options: ScenarioOptions, frames: FramePolicy, testInfo: TestInfo): Promise<RunningContext> {
    this.frames = frames;
    this.exceptPlatforms = Object.keys(options.exceptPlatforms ?? {});
    this.testInfo = testInfo;
    this.workspaceTrust = options.workspaceTrust;
    const home = await createTestHome(`e2e-${this.surface}`);
    this.home = home;
    assertOutsideGitWorkTree(home.workspace);
    await seedWorkspace(home.workspace, options.workspace ?? {});
    const model = await startFakeModel();
    this.model = model;
    await writeKimiConfig(home.dataDir, mergeKimiConfig(fakeModelConfig(model, options.provider), options.config ?? {}));
    await this.startMcpServers(home, options.mcp);
    if (options.clock !== undefined) await writeFile(clockFileOf(home), timeOf(options.clock));
    const startupStep = this.workspaceTrust === undefined ? '启动产品，等到可以输入' : '启动产品，处理工作区信任提示';
    await base.step(startupStep, async () => {
      this.driver = await this.launch({ home, model, workspaceTrust: this.workspaceTrust, ...this.launchOptions() });
      this.baseline = await snapshotDirectory(home.workspace);
      if (frames === 'every-step') await this.show('00 启动完成');
    });
    return {
      product: this.userActions(),
      model,
      workspace: this.workspace(home.workspace),
      mcp: (name) => this.mcpServer(name),
      clock: (time) =>
        base.step(CLOCK_TITLE(time), async () => {
          if (options.clock === undefined) throw new Error('clock() moves the clock of the machine; give the scenario a starting time with the clock option.');
          await writeFile(clockFileOf(home), timeOf(time));
        }),
    };
  }

  private async startMcpServers(home: TestHome, servers: ScenarioOptions['mcp']): Promise<void> {
    if (servers === undefined) return;
    const entries: Record<string, McpRemoteServerEntry> = {};
    for (const [name, { tools, deferred, from }] of Object.entries(servers)) {
      const server = await startFakeMcpHttpServer({ name, tools });
      this.mcpServers.set(name, server);
      if (from === 'editor') this.editorMcpServers.push({ name, url: server.url });
      else entries[name] = deferred === undefined ? { transport: 'http', url: server.url } : { transport: 'http', url: server.url, deferred };
    }
    if (Object.keys(entries).length > 0) await writeMcpConfig(join(home.dataDir, 'mcp.json'), entries);
  }

  private mcpServer(name: string): McpServerHandle {
    const server = this.mcpServers.get(name);
    if (server === undefined) {
      const declared = [...this.mcpServers.keys()];
      throw new Error(
        `The scenario declares no MCP server named ${JSON.stringify(name)}; declare it in the mcp option. Declared: ${declared.length === 0 ? 'none' : declared.join(', ')}.`,
      );
    }
    const relisted = (title: string, change: () => void): Promise<void> =>
      base.step(title, async () => {
        const before = server.requests.length;
        change();
        await until(`MCP server ${JSON.stringify(name)} to answer the product's next tools/list`, () =>
          server.answered.some((request) => server.requests.indexOf(request) >= before && request.rpcMethods.includes('tools/list')),
        );
      });
    return {
      addTool: (tool) => relisted(MCP_TITLES.addTool(name, tool.name), () => server.addTool(tool)),
      updateTool: (tool, change) => relisted(MCP_TITLES.updateTool(name, tool), () => server.updateTool(tool, change)),
      removeTool: (tool) => relisted(MCP_TITLES.removeTool(name, tool), () => server.removeTool(tool)),
      disconnect: () =>
        base.step(MCP_TITLES.disconnect(name), async () => {
          const before = server.requests.length;
          await server.disconnect();
          await until(`the product to connect to MCP server ${JSON.stringify(name)} again and list its tools`, () => {
            const since = server.answered.filter((request) => server.requests.indexOf(request) >= before);
            const initialized = since.findIndex((request) => request.rpcMethods.includes('initialize'));
            return initialized !== -1 && since.slice(initialized).some((request) => request.rpcMethods.includes('tools/list'));
          });
        }),
    };
  }

  async finish(testInfo: TestInfo): Promise<void> {
    const { home, model } = this;
    if (home === undefined) return;
    let clean = false;
    try {
      const passed = testInfo.status === testInfo.expectedStatus;
      if (!passed) await this.show(this.failedStep === undefined ? `${this.nextStep()} 失败时的画面` : `${this.failedStep}：失败时的画面`);
      const problems = passed ? await this.closingProblems() : [];
      if (!passed || problems.length > 0) await this.attachDiagnostics(testInfo);
      if (problems.length > 0) throw new Error(`The scenario body passed, but the closing checks failed:\n\n${problems.join('\n\n')}`);
      clean = passed;
    } finally {
      await this.driver?.kill();
      await model?.close();
      for (const server of this.mcpServers.values()) await server.close();
      if (clean) await home.remove();
      else testInfo.annotations.push({ type: 'test home', description: home.root });
    }
  }

  private userActions(): Actions {
    return Object.fromEntries(VERB_NAMES.map((verb) => [verb, (...args: readonly unknown[]) => this.perform(verb, args)])) as unknown as Actions;
  }

  private async perform(verb: Verb, args: readonly unknown[]): Promise<void> {
    this.performed.add(verb);
    const number = this.nextStep();
    const title = (STEP_TITLES[verb] as (...values: readonly unknown[]) => string)(...args);
    this.failedStep = undefined;
    await base.step(title, async () => {
      try {
        (PRECHECKS[verb] as ((...values: readonly unknown[]) => void) | undefined)?.(...args);
        await this.dispatch(verb, args);
      } catch (error) {
        this.failedStep = `${number} ${title}`;
        throw error;
      }
      if (verbSpec(verb).checksInterface) this.interfaceChecks += 1;
      if (this.frames === 'every-step') await this.show(`${number} ${title}之后`);
    });
  }

  private async dispatch(verb: Verb, args: readonly unknown[]): Promise<void> {
    if (verb === 'restart') {
      await this.restart();
      return;
    }
    if (verb === 'restartDuringTurn') {
      await this.restartDuringTurn();
      return;
    }
    const unavailable = unavailableReason(verb, process.platform);
    if (unavailable !== undefined) {
      throw new Error(`${verb}() cannot be checked on ${process.platform}: ${unavailable} Leave the platform out of the scenario with exceptPlatforms.`);
    }
    if (!verbOn(verb, this.surface)) {
      throw new Error(
        `${verb}() does not exist on ${this.surface}: ${absenceReason(verb, this.surface)} Leave ${this.surface} out of the scenario with except or onlyOn.`,
      );
    }
    const driver = this.driver;
    if (driver === undefined) throw new Error(`${verb}() was called while the product is not running.`);
    const method: unknown = Reflect.get(driver, verb);
    if (typeof method !== 'function') throw new Error(`The ${this.surface} driver does not implement ${verb}().`);
    await Reflect.apply(method, driver, args);
    if (verb === 'send' || verb === 'queue' || verb === 'steer' || verb === 'submit') this.lastPrompt = String(args[0]);
    if (verb === 'undo') this.lastPrompt = undefined;
    if (verb === 'newSession') {
      this.lastPrompt = undefined;
      this.sessions += 1;
    }
  }

  private async launch(launch: SurfaceLaunch): Promise<SurfaceDriver<Surface>> {
    try {
      return await startSurface(this.surface, launch);
    } catch (error) {
      if (error instanceof StartupFailure) {
        for (const diagnostic of error.diagnostics) this.earlierDiagnostics.push({ ...diagnostic, name: `launch-${this.launches}-${diagnostic.name}` });
      }
      throw error;
    }
  }

  private launchOptions(): Pick<SurfaceLaunch, 'variant' | 'editorMcpServers'> {
    return {
      ...(this.variant === undefined ? {} : { variant: this.variant }),
      ...(this.editorMcpServers.length === 0 ? {} : { editorMcpServers: this.editorMcpServers }),
    };
  }

  private async restart(): Promise<void> {
    const running = this.running('restart');
    if (!(await running.driver.idle())) {
      throw new Error(
        'restart() needs an idle product: a user lets the turn end, or stops it, and answers any approval before closing the app. To quit while a turn is running, use restartDuringTurn().',
      );
    }
    await this.reopen('restart', running, () => running.driver.close());
  }

  private async restartDuringTurn(): Promise<void> {
    const running = this.running('restartDuringTurn');
    if (await running.driver.idle()) {
      throw new Error('restartDuringTurn() needs a running turn, but the product is idle; use restart() to close and reopen an idle product.');
    }
    await this.reopen('restartDuringTurn', running, () => running.driver.quitDuringTurn());
  }

  private running(verb: string): RunningProduct {
    const { home, model, driver } = this;
    if (home === undefined || model === undefined || driver === undefined) throw new Error(`${verb}() was called while the product is not running.`);
    return { home, model, driver };
  }

  private async reopen(verb: string, { home, model, driver }: RunningProduct, quit: () => Promise<void>): Promise<void> {
    const state = driver.reopenState();
    const problems = await this.shutdownProblems(driver, quit);
    for (const diagnostic of await driver.diagnostics()) this.earlierDiagnostics.push({ ...diagnostic, name: `launch-${this.launches}-${diagnostic.name}` });
    await driver.kill();
    this.driver = undefined;
    if (problems.length > 0) throw new Error(`The product did not shut down cleanly before ${verb}():\n\n${problems.join('\n\n')}`);
    this.launches += 1;
    this.driver = await this.launch({
      home,
      model,
      workspaceTrust: this.workspaceTrust,
      reopen: { launch: this.launches, lastPrompt: this.lastPrompt, state },
      ...this.launchOptions(),
    });
  }

  private async shutdownProblems(driver: SurfaceDriver<Surface>, quit: () => Promise<void>): Promise<string[]> {
    const problems: string[] = [];
    try {
      await quit();
    } catch (error) {
      problems.push(`The product did not shut down cleanly:\n${problemOf(error)}`);
    }
    try {
      const violations = await driver.networkViolations();
      if (violations.length > 0) {
        problems.push(
          `The product tried to reach ${violations.length} address(es) outside this machine; only the fake model may be contacted:\n${violations.map((violation) => `- ${violation}`).join('\n')}`,
        );
      }
    } catch (error) {
      problems.push(`The network guard record could not be read:\n${problemOf(error)}`);
    }
    return problems;
  }

  private nextStep(): string {
    this.steps += 1;
    return String(this.steps).padStart(2, '0');
  }

  private async show(name: string): Promise<void> {
    const { driver, testInfo } = this;
    if (driver === undefined || testInfo === undefined) return;
    let frame: Frame;
    try {
      frame = await driver.frame();
    } catch (error) {
      frame = { kind: 'text', text: `取不到这一刻的画面：${problemOf(error)}` };
    }
    if (frame.kind === 'image') await testInfo.attach(`${name}.png`, { body: frame.png, contentType: 'image/png' });
    else await testInfo.attach(`${name}.txt`, { body: frame.text, contentType: 'text/plain' });
  }

  private workspace(root: string): Workspace {
    return {
      read: (path) => readFile(join(root, workspaceKey(path)), 'utf8'),
      write: (path, content) =>
        base.step(DISK_TITLES.write(path, content), async () => {
          const key = workspaceKey(path);
          await seedWorkspace(root, { [key]: content });
          this.declared.set(key, contentDigest(content));
        }),
      expectFile: (path, content) =>
        base.step(DISK_TITLES.file(path, content), async () => {
          const key = workspaceKey(path);
          this.declared.set(key, contentDigest(content));
          expect(await readIfPresent(join(root, key)), `workspace file ${key}`).toBe(content);
        }),
      expectMissing: (path) =>
        base.step(DISK_TITLES.missing(path), async () => {
          const key = workspaceKey(path);
          this.declared.set(key, undefined);
          expect(await readIfPresent(join(root, key)), `workspace file ${key} should not exist`).toBeUndefined();
        }),
    };
  }

  private async closingProblems(): Promise<string[]> {
    const { home, model, driver, baseline } = this;
    if (home === undefined || model === undefined || driver === undefined || baseline === undefined) return [];
    const problems = await this.shutdownProblems(driver, () => driver.close());
    if (this.interfaceChecks === 0) {
      problems.push('The scenario never checked the interface. Add at least one product.expectTool(), product.expectReply() or another product.expect…() check.');
    }
    for (const platform of this.exceptPlatforms) {
      if (![...this.performed].some((verb) => unavailableReason(verb, platform) !== undefined)) {
        problems.push(
          `The scenario leaves out ${platform} with exceptPlatforms, but none of the actions it used is unavailable there. exceptPlatforms only covers checks the driver cannot make on a platform; a failure the product causes there is a bug to record, not to leave out.`,
        );
      }
    }
    try {
      model.verify();
    } catch (error) {
      problems.push(`The fake model reported problems:\n${problemOf(error)}`);
    }
    const keys = [...new Set(model.promptCache().filter((entry) => entry.role === 'main' && !entry.rejected).map((entry) => entry.cacheKey))];
    if (keys.length > this.sessions) {
      problems.push(
        `The product sent main requests under ${keys.length} prompt cache keys (${keys.map((key) => JSON.stringify(key ?? null)).join(', ')}), but the scenario used ${this.sessions} session(s). ` +
          'A provider reuses a cached prefix only under the same key, so every request of a session must keep its key, also after a restart.',
      );
    }
    const changes = directoryChanges(this.expectedWorkspace(baseline), await snapshotDirectory(home.workspace));
    if (changes.length > 0) {
      problems.push(
        [
          'The workspace differs from what the scenario declared:',
          ...changes.map((change) => `- ${change.kind} ${change.path}`),
          'Declare every expected change with workspace.expectFile() or workspace.expectMissing(); every other file must stay untouched.',
        ].join('\n'),
      );
    }
    return problems;
  }

  private expectedWorkspace(baseline: DirectorySnapshot): DirectorySnapshot {
    const expected: Record<string, string> = { ...baseline };
    for (const [path, digest] of this.declared) {
      if (digest === undefined) delete expected[path];
      else expected[path] = digest;
    }
    return expected;
  }

  private async attachDiagnostics(testInfo: TestInfo): Promise<void> {
    const { home, model, driver } = this;
    if (model !== undefined) {
      const requests = model.requests().map(({ index, lane, state }) => ({ index, lane, state }));
      await testInfo.attach('model-requests', { body: JSON.stringify({ requests, problems: model.problems() }, null, 2), contentType: 'application/json' });
      await testInfo.attach('prompt-cache', {
        body: JSON.stringify({ problems: model.promptCacheProblems(), entries: model.promptCache() }, null, 2),
        contentType: 'application/json',
      });
    }
    for (const diagnostic of this.earlierDiagnostics) {
      if ('path' in diagnostic) await testInfo.attach(diagnostic.name, { path: diagnostic.path });
      else await testInfo.attach(diagnostic.name, { body: diagnostic.body, contentType: 'text/plain' });
    }
    if (driver !== undefined) {
      for (const diagnostic of await driver.diagnostics()) {
        if ('path' in diagnostic) await testInfo.attach(diagnostic.name, { path: diagnostic.path });
        else await testInfo.attach(diagnostic.name, { body: diagnostic.body, contentType: 'text/plain' });
      }
      const violations = await driver.networkViolations().catch((error: unknown) => [problemOf(error)]);
      await testInfo.attach('network-guard', { body: violations.join('\n'), contentType: 'text/plain' });
    }
    if (home === undefined) return;
    const logs = join(home.dataDir, 'logs');
    for (const entry of await readdir(logs, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile()) await testInfo.attach(`product-log-${entry.name}`, { path: join(logs, entry.name), contentType: 'text/plain' });
    }
  }
}

const test = base.extend<SurfaceOptions & { session: ScenarioSession }>({
  surface: [undefined, { option: true }],
  variant: [undefined, { option: true }],
  session: async ({ surface, variant }, use, testInfo) => {
    if (surface === undefined) throw new Error(`The Playwright project must set use.surface to one of: ${SURFACES.join(', ')}`);
    if (variant !== undefined && VARIANTS[variant] !== surface) throw new Error(`The Playwright project runs ${surface}, but the variant ${variant} belongs to ${VARIANTS[variant]}.`);
    const session = new ScenarioSession(surface, variant);
    await use(session);
    await session.finish(testInfo);
  },
});

function assertScenarioOptions(title: string, options: ScenarioOptions): void {
  const fromEditor = Object.entries(options.mcp ?? {}).filter(([, server]) => server.from === 'editor');
  if (fromEditor.length > 0 && (options.onlyOn?.length !== 1 || options.onlyOn[0] !== 'acp')) {
    throw new Error(`Scenario "${title}" lets the editor pass MCP server(s) ${fromEditor.map(([name]) => name).join(', ')}, which only an ACP editor does; limit the scenario to ACP.`);
  }
  if (fromEditor.some(([, server]) => server.deferred !== undefined)) {
    throw new Error(`Scenario "${title}" sets deferred on an MCP server the editor passes; an ACP editor cannot mark a server as deferred.`);
  }
  if (options.workspaceTrust !== undefined && (options.onlyOn?.length !== 1 || options.onlyOn[0] !== 'tui')) {
    throw new Error(`Scenario "${title}" sets workspaceTrust without limiting the scenario to TUI.`);
  }
  for (const [surface, reason] of Object.entries(options.except ?? {})) {
    if (reason.trim() === '') throw new Error(`Scenario "${title}" excludes ${surface} without a reason.`);
  }
  for (const [platform, reason] of Object.entries(options.exceptPlatforms ?? {})) {
    if (reason.trim() === '') throw new Error(`Scenario "${title}" excludes the ${platform} platform without a reason.`);
  }
  for (const [variant, reason] of Object.entries(options.exceptVariants ?? {})) {
    if (reason.trim() === '') throw new Error(`Scenario "${title}" excludes the ${variant} variant without a reason.`);
  }
  if (options.onlyOn !== undefined && (options.onlyOn.length === 0 || (options.reason ?? '').trim() === '')) {
    throw new Error(`Scenario "${title}" uses onlyOn; it must name at least one surface and give a reason.`);
  }
  if (options.onlyOn === undefined && options.reason !== undefined) {
    throw new Error(`Scenario "${title}" gives a reason without onlyOn; put per-surface reasons in except.`);
  }
}

function notApplicableReason(options: ScenarioOptions, surface: Surface): string | undefined {
  const excluded = options.except?.[surface];
  if (excluded !== undefined) return excluded;
  return options.onlyOn === undefined || options.onlyOn.includes(surface) ? undefined : options.reason;
}

function platformExclusion(options: ScenarioOptions): string | undefined {
  const reasons: Readonly<Partial<Record<string, string>>> = options.exceptPlatforms ?? {};
  return reasons[process.platform];
}

function register(title: string, options: ScenarioOptions, body: RunningBody, frames: FramePolicy): void {
  assertScenarioOptions(title, options);
  test(title, async ({ surface, variant, session }, testInfo) => {
    const reason = surface === undefined ? undefined : notApplicableReason(options, surface);
    testInfo.skip(reason !== undefined, `not applicable on ${String(surface)}: ${String(reason)}`);
    const platformReason = platformExclusion(options);
    testInfo.skip(platformReason !== undefined, `not applicable on ${process.platform}: ${String(platformReason)}`);
    const variantReason = variant === undefined ? undefined : options.exceptVariants?.[variant];
    testInfo.skip(variantReason !== undefined, `not applicable on ${String(variant)}: ${String(variantReason)}`);
    await body(await session.start(options, frames, testInfo));
  });
}

export function scenario<const O extends ScenarioOptions>(title: string, options: O, body: ScenarioBody<RunsOn<O>>): void {
  register(title, options, body as unknown as RunningBody, 'every-step');
}

function selfTestFile(verb: Verb): string {
  return `${verb.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.spec.ts`;
}

function withinVerb(verb: Verb, title: string, given: ScenarioOptions): ScenarioOptions {
  const spec = verbSpec(verb);
  const options = spec.unavailableOn === undefined ? given : { ...given, exceptPlatforms: { ...spec.unavailableOn, ...given.exceptPlatforms } };
  const absent = SURFACES.filter((surface) => !spec.on.includes(surface));
  if (absent.length === 0) return options;
  if (options.onlyOn !== undefined) {
    const outside = options.onlyOn.filter((surface) => !spec.on.includes(surface));
    if (outside.length > 0) throw new Error(`Self-test "${title}" runs on ${outside.join(', ')}, where ${verb}() does not exist.`);
    return options;
  }
  const reasons = absent.map((surface) => [surface, `${verb}() does not exist here: ${absenceReason(verb, surface)}`]);
  return { ...options, except: { ...Object.fromEntries(reasons), ...options.except } };
}

export function selfTestCase<const O extends ScenarioOptions>(options: O, run: ScenarioBody<RunsOn<O>>): SelfTestCase<Surface> {
  return { ...options, run: run as unknown as ScenarioBody<Surface> };
}

export function selfTest<V extends Verb>(verb: V, suite: SelfTestSuite<SurfacesOf<V>>): void {
  const surfaces = SURFACES.filter((surface) => verbOn(verb, surface));
  for (const kind of SELF_TEST_KINDS) {
    const cases = Object.entries(suite[kind]).map(([title, { run, ...options }]) => {
      const name = `${verb} ${kind}: ${title}`;
      return { name, run, options: withinVerb(verb, name, options) };
    });
    for (const { name, options } of cases) assertScenarioOptions(name, options);
    const uncovered = surfaces.filter((surface) => cases.every(({ options }) => notApplicableReason(options, surface) !== undefined));
    if (uncovered.length > 0) {
      throw new Error(`The ${verb} self-test has no ${kind} case on: ${uncovered.join(', ')}. Every user action needs both kinds on every surface where it exists.`);
    }
    for (const { name, run, options } of cases) register(name, options, run as unknown as RunningBody, 'on-failure');
  }
}

export function selfTestCoverage(): void {
  test('every user action has a self-test file that declares its positive and negative cases', () => {
    const missing = VERB_NAMES.filter((verb) => {
      const file = join(SELF_TEST_DIRECTORY, selfTestFile(verb));
      return !existsSync(file) || !readFileSync(file, 'utf8').includes(`selfTest('${verb}',`);
    });
    expect(
      missing.map((verb) => `${verb}: expected self-test/${selfTestFile(verb)} to call selfTest('${verb}', …)`),
      'user actions without a self-test',
    ).toEqual([]);
  });
}
