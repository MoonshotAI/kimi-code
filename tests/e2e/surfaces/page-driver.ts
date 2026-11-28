import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { TIMEOUTS } from '@moonshot-ai/testkit/fixtures';
import type { BrowserContext, Page } from '@playwright/test';

import type { ApprovalExpectation, ApproveOptions, Diagnostic, Frame, PermissionMode, PlanModeState, ReopenState, SessionBadge, SurfaceDriver, TaskExpectation, ToolExpectation } from '../support/verbs';
import { RendererSurface, type MenuPage } from './renderer';

export const WELCOME_DIALOG = 'Welcome to Kimi Code';

export const OFFLINE_NAMES = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1';

const LOCAL_SCHEMES = new Set(['app:', 'file:', 'data:', 'blob:', 'about:', 'devtools:', 'chrome:']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function reasonOf(error: unknown): string {
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

export abstract class PageDriver implements SurfaceDriver<'desktop' | 'web'> {
  protected readonly beyond: string[] = [];
  protected readonly trace: string;
  protected readonly context: BrowserContext;
  private readonly pageErrors: string[] = [];
  private readonly name: string;
  private tracing = false;
  private traceProblem: string | undefined;
  private renderer: RendererSurface | undefined;
  private page: Page | undefined;
  private lastPage = 'The page never became ready.';

  protected constructor(context: BrowserContext, root: string, name: string, launch: number) {
    this.context = context;
    this.name = name;
    this.trace = join(root, `${name}-${launch}-trace.zip`);
    context.on('request', (request) => {
      if (reachesBeyondThisMachine(request.url())) this.beyond.push(`${request.method()} ${request.url()}`);
    });
    context.on('weberror', (event) => {
      const error = event.error();
      this.pageErrors.push(error.stack ?? error.message);
    });
    context.on('page', (page) => {
      this.watchSockets(page);
    });
    for (const page of context.pages()) this.watchSockets(page);
  }

  abstract close(): Promise<void>;

  abstract quitDuringTurn(): Promise<void>;

  abstract reopenState(): ReopenState;

  abstract kill(): Promise<void>;

  abstract networkViolations(): Promise<readonly string[]>;

  abstract diagnostics(): Promise<readonly Diagnostic[]>;

  send(text: string): Promise<void> {
    return this.window().send(text);
  }

  queue(text: string): Promise<void> {
    return this.window().queue(text);
  }

  steer(text: string): Promise<void> {
    return this.window().steer(text);
  }

  approve(options?: ApproveOptions): Promise<void> {
    return this.window().approve(options);
  }

  reject(): Promise<void> {
    return this.window().reject();
  }

  rejectWithFeedback(feedback: string): Promise<void> {
    return this.window().rejectWithFeedback(feedback);
  }

  expectApproval(expectation: ApprovalExpectation): Promise<void> {
    return this.window().expectApproval(expectation);
  }

  answer(option: string): Promise<void> {
    return this.window().answer(option);
  }

  answerOther(text: string): Promise<void> {
    return this.window().answerOther(text);
  }

  dismissQuestion(): Promise<void> {
    return this.window().dismissQuestion();
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    return this.window().setPermissionMode(mode);
  }

  switchModel(name: string): Promise<void> {
    return this.window().switchModel(name);
  }

  setThinkingEffort(effort: string): Promise<void> {
    return this.window().setThinkingEffort(effort);
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

  expectError(text: string): Promise<void> {
    return this.window().expectError(text);
  }

  expectAbsent(text: string): Promise<void> {
    return this.window().expectAbsent(text);
  }

  continue(): Promise<void> {
    return this.window().continue();
  }

  expectTranscript(text: string): Promise<void> {
    return this.window().expectTranscript(text);
  }

  undo(): Promise<void> {
    return this.window().undo();
  }

  steerQueued(): Promise<void> {
    return this.window().steerQueued();
  }

  background(): Promise<void> {
    return this.window().background();
  }

  expectTask(expectation: TaskExpectation): Promise<void> {
    return this.window().expectTask(expectation);
  }

  stopTask(description: string): Promise<void> {
    return this.window().stopTask(description);
  }

  expectStopped(): Promise<void> {
    return this.window().expectStopped();
  }

  recallPrevious(): Promise<void> {
    return this.window().recallPrevious();
  }

  submit(text: string): Promise<void> {
    return this.window().submit(text);
  }

  expectComposer(text: string): Promise<void> {
    return this.window().expectComposer(text);
  }

  newSession(): Promise<void> {
    return this.window().newSession();
  }

  fork(): Promise<void> {
    return this.window().fork();
  }

  deleteSession(title: string): Promise<void> {
    return this.window().deleteSession(title);
  }

  archiveSession(title: string): Promise<void> {
    return this.window().archiveSession(title);
  }

  expectSessions(titles: readonly string[]): Promise<void> {
    return this.window().expectSessions(titles);
  }

  expectSessionBadge(title: string, badge: SessionBadge): Promise<void> {
    return this.window().expectSessionBadge(title, badge);
  }

  removeWorkspace(): Promise<void> {
    return this.window().removeWorkspace();
  }

  addWorkspace(): Promise<void> {
    return this.window().addWorkspace();
  }

  compact(): Promise<void> {
    return this.window().compact();
  }

  openSession(title: string): Promise<void> {
    return this.window().openSession(title);
  }

  reload(): Promise<void> {
    return this.window().reload();
  }

  useSkill(name: string): Promise<void> {
    return this.window().useSkill(name);
  }

  setPlanMode(state: PlanModeState): Promise<void> {
    return this.window().setPlanMode(state);
  }

  btw(question: string, reply: string): Promise<void> {
    return this.window().btw(question, reply);
  }

  idle(): Promise<boolean> {
    return this.window().idle();
  }

  protected resizeWindow(viewport: { readonly width: number; readonly height: number }): Promise<void> {
    return this.window().resize(viewport);
  }

  protected switchBrowserControl(enabled: boolean): Promise<void> {
    return this.window().setBrowserControl(enabled);
  }

  protected async awaitResumed(lastPrompt: string | undefined): Promise<void> {
    if (lastPrompt !== undefined) await this.window().awaitMessage(lastPrompt);
    if (this.page !== undefined && (await this.page.getByRole('dialog', { name: WELCOME_DIALOG }).isVisible())) {
      throw new Error(`The welcome dialog came back after the restart; a returning user should not be onboarded again.\n${await this.window().describe()}`);
    }
  }

  protected async reloadWindow(): Promise<void> {
    const page = this.page;
    if (page === undefined) throw new Error(`The ${this.name} page is not ready.`);
    const before = page.url();
    await page.reload({ timeout: TIMEOUTS.server });
    await page.getByRole('status', { name: 'Connecting…' }).first().waitFor({ state: 'hidden', timeout: TIMEOUTS.server });
    await page.getByRole('combobox', { name: 'Message input' }).waitFor({ state: 'visible', timeout: TIMEOUTS.server });
    if (page.url() !== before) throw new Error(`reloadPage() came back at ${page.url()} instead of ${before}.\n${await this.window().describe()}`);
  }

  protected async startTrace(): Promise<void> {
    await this.context.tracing.start({ screenshots: true, snapshots: true });
    this.tracing = true;
  }

  async frame(): Promise<Frame> {
    if (this.page === undefined) throw new Error(`The ${this.name} page is not ready.`);
    return { kind: 'image', png: await this.page.screenshot({ scale: 'css', caret: 'initial', timeout: TIMEOUTS.wait }) };
  }

  protected show(page: Page, workspace: string, menus: MenuPage): void {
    this.page = page;
    this.renderer = new RendererSurface(page, workspace, menus);
  }

  protected async leave(): Promise<void> {
    this.lastPage = await this.window().describe();
    if (!(await this.window().idle())) {
      throw new Error(`The scenario ended while a turn was running or an approval was pending; end it with waitIdle().\n${this.lastPage}`);
    }
    await this.saveTrace();
  }

  protected async leaveDuringTurn(): Promise<void> {
    this.lastPage = await this.window().describe();
    await this.saveTrace();
  }

  protected async readPage(): Promise<string> {
    if (this.renderer !== undefined) this.lastPage = await this.renderer.describe();
    return this.lastPage;
  }

  protected async saveTrace(): Promise<void> {
    if (!this.tracing) return;
    this.tracing = false;
    try {
      await this.context.tracing.stop({ path: this.trace });
    } catch (error) {
      this.traceProblem = `The trace could not be saved: ${reasonOf(error)}`;
    }
  }

  protected pageDiagnostics(): readonly Diagnostic[] {
    return [...(existsSync(this.trace) ? [{ name: `${this.name}-trace`, path: this.trace }] : []), { name: `${this.name}-page`, body: this.lastPage }];
  }

  protected pageProblems(): readonly string[] {
    return this.pageErrors.length === 0 ? [] : [`The page reported ${this.pageErrors.length} uncaught error(s):\n${this.pageErrors.join('\n')}`];
  }

  protected describePage(): string {
    return [
      `Requests beyond this machine: ${JSON.stringify(this.beyond)}`,
      `Uncaught errors in the page: ${JSON.stringify(this.pageErrors)}`,
      ...(this.traceProblem === undefined ? [] : [this.traceProblem]),
    ].join('\n');
  }

  private window(): RendererSurface {
    if (this.renderer === undefined) throw new Error(`The ${this.name} page is not ready.`);
    return this.renderer;
  }

  private watchSockets(page: Page): void {
    page.on('websocket', (socket) => {
      if (reachesBeyondThisMachine(socket.url())) this.beyond.push(`socket ${socket.url()}`);
    });
  }
}
