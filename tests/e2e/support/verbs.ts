import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import type { TestHome } from '@moonshot-ai/testkit/fixtures';
import type { FakeModel } from '@moonshot-ai/testkit/model';

export const SURFACES = ['tui', 'acp', 'desktop', 'web'] as const;

export type Surface = (typeof SURFACES)[number];

export type Platform = 'darwin' | 'linux' | 'win32';

export const VARIANTS = { 'kitty-keyboard': 'tui', 'bare-editor': 'acp' } as const satisfies Readonly<Record<string, Surface>>;

export type Variant = keyof typeof VARIANTS;

interface VerbSpec {
  readonly on: readonly Surface[];
  readonly absentBecause?: string | Readonly<Partial<Record<Surface, string>>>;
  readonly unavailableOn?: Readonly<Partial<Record<Platform, string>>>;
  readonly checksInterface: boolean;
  readonly bySession?: true;
}

const ONLY_IN_A_SHELL = "Only the terminal UI runs inside the user's own shell, so only there does leaving the product hand a terminal back to the user.";
const NO_REASON_OVER_ACP = 'ACP permission options carry only an option id, so an editor cannot send a reason with a rejection.';
const ONE_PROMPT_AT_A_TIME_OVER_ACP =
  'ACP has no way to send a message while a turn runs: a second session/prompt is refused (-32600, another turn is already in progress).';
const NO_FREE_TEXT_OVER_ACP = "ACP's permission request carries only option ids, so an editor cannot send a free-text answer.";
const INPUT_IN_THE_EDITOR = "An editor writes prompts in its own input and keeps its own prompt history; the agent behind ACP never sees the user's input.";
const NO_UNDO_OVER_ACP = 'ACP has no request to withdraw a message from the conversation.';
const NO_DEFAULT_MODE_SETTING = {
  tui: "The terminal UI's permission setting, under /permission and /settings alike, changes only the current session; the default for new sessions lives in config.toml.",
  acp: 'ACP has no settings: an editor sets the mode of each session with session/set_mode.',
};
const NO_STOP_MARK_OVER_ACP =
  "ACP has no message that marks a turn as stopped: an editor learns it from the cancelled stop reason, which stop() already checks, and a session/load replay carries no trace of it.";
const NO_WINDOW_TO_RESIZE = {
  acp: 'An editor shows the conversation in its own window; the agent behind ACP has no window to resize.',
  desktop: "The Desktop window cannot be made narrower than 900 pixels, so a user cannot give it a phone width, and Playwright can only resize it by running code in Electron's main process.",
};
const NO_TASKS_OVER_ACP = 'ACP has no background tasks an editor can move, list or stop: the agent reports only tool calls.';
const NO_PAGE_TO_RELOAD = {
  tui: 'A terminal shows the CLI itself; there is no page to reload.',
  acp: 'An editor shows the conversation in its own interface; there is no page of the agent to reload.',
  desktop: "Desktop reloads its window only from the Force Reload item of its native View menu, which the driver cannot reach.",
};
const NO_CONTINUE = {
  tui: 'The terminal UI has no way to continue a failed turn; a user sends another message instead.',
  acp: 'ACP has no request to continue a failed turn.',
};

export const VERBS = {
  send: { on: SURFACES, checksInterface: false },
  queue: { on: ['tui', 'desktop', 'web'], absentBecause: ONE_PROMPT_AT_A_TIME_OVER_ACP, checksInterface: false },
  steer: { on: ['tui', 'desktop', 'web'], absentBecause: ONE_PROMPT_AT_A_TIME_OVER_ACP, checksInterface: false },
  steerQueued: { on: ['tui', 'desktop', 'web'], absentBecause: ONE_PROMPT_AT_A_TIME_OVER_ACP, checksInterface: false },
  background: { on: ['tui', 'desktop', 'web'], absentBecause: NO_TASKS_OVER_ACP, checksInterface: false },
  expectTask: { on: ['tui', 'desktop', 'web'], absentBecause: NO_TASKS_OVER_ACP, checksInterface: true },
  stopTask: { on: ['tui', 'desktop', 'web'], absentBecause: NO_TASKS_OVER_ACP, checksInterface: false },
  approve: { on: SURFACES, checksInterface: false },
  reject: { on: SURFACES, checksInterface: false },
  rejectWithFeedback: { on: ['tui', 'desktop', 'web'], absentBecause: NO_REASON_OVER_ACP, checksInterface: false },
  expectApproval: { on: SURFACES, checksInterface: true },
  answer: { on: SURFACES, checksInterface: false },
  answerOther: { on: ['tui', 'desktop', 'web'], absentBecause: NO_FREE_TEXT_OVER_ACP, checksInterface: false },
  dismissQuestion: { on: SURFACES, checksInterface: false },
  setPermissionMode: { on: SURFACES, checksInterface: false },
  chooseModel: { on: SURFACES, checksInterface: false },
  setThinking: { on: SURFACES, checksInterface: false },
  setDefaultPermissionMode: { on: ['desktop', 'web'], absentBecause: NO_DEFAULT_MODE_SETTING, checksInterface: false },
  stop: { on: SURFACES, checksInterface: false },
  expectStopped: { on: ['tui', 'desktop', 'web'], absentBecause: NO_STOP_MARK_OVER_ACP, checksInterface: true },
  waitIdle: { on: SURFACES, checksInterface: false },
  waitForUsageUpdates: { on: ['acp'], absentBecause: 'This action waits for usage updates delivered to an ACP editor.', checksInterface: false },
  expectTool: { on: SURFACES, checksInterface: true },
  expectReply: { on: SURFACES, checksInterface: true },
  expectError: { on: SURFACES, checksInterface: true },
  expectAbsent: { on: SURFACES, checksInterface: false },
  continue: { on: ['desktop', 'web'], absentBecause: NO_CONTINUE, checksInterface: false },
  restart: { on: SURFACES, checksInterface: false, bySession: true },
  restartDuringTurn: { on: SURFACES, checksInterface: false, bySession: true },
  undo: { on: ['tui', 'desktop', 'web'], absentBecause: NO_UNDO_OVER_ACP, checksInterface: false },
  recallPrevious: { on: ['tui', 'desktop', 'web'], absentBecause: INPUT_IN_THE_EDITOR, checksInterface: false },
  submit: { on: ['tui', 'desktop', 'web'], absentBecause: INPUT_IN_THE_EDITOR, checksInterface: false },
  expectComposer: { on: ['tui', 'desktop', 'web'], absentBecause: INPUT_IN_THE_EDITOR, checksInterface: true },
  newSession: { on: SURFACES, checksInterface: false },
  compact: { on: SURFACES, checksInterface: false },
  resize: { on: ['tui', 'web'], absentBecause: NO_WINDOW_TO_RESIZE, checksInterface: false },
  reload: { on: ['web'], absentBecause: NO_PAGE_TO_RELOAD, checksInterface: false },
  expectTranscript: { on: SURFACES, checksInterface: true },
  exit: { on: ['tui'], absentBecause: ONLY_IN_A_SHELL, checksInterface: false },
  expectTerminalRestored: {
    on: ['tui'],
    absentBecause: ONLY_IN_A_SHELL,
    unavailableOn: {
      win32: 'Windows keeps the input modes in the console rather than in a POSIX terminal, and the driver cannot read them back after the CLI exits yet.',
    },
    checksInterface: true,
  },
} as const satisfies Readonly<Record<string, VerbSpec>>;

export type Verb = keyof typeof VERBS;

export const VERB_NAMES = Object.keys(VERBS) as readonly Verb[];

export type SurfacesOf<V extends Verb> = (typeof VERBS)[V]['on'][number];

export function verbSpec(verb: Verb): VerbSpec {
  return VERBS[verb];
}

export function verbOn(verb: Verb, surface: Surface): boolean {
  return verbSpec(verb).on.includes(surface);
}

export function unavailableReason(verb: Verb, platform: string): string | undefined {
  const reasons: Readonly<Partial<Record<string, string>>> = verbSpec(verb).unavailableOn ?? {};
  return reasons[platform];
}

export function absenceReason(verb: Verb, surface: Surface): string {
  const reason = verbSpec(verb).absentBecause;
  return (typeof reason === 'string' ? reason : reason?.[surface]) ?? '';
}

type FileToolName = 'Read' | 'Edit' | 'Write';

export type ToolName = FileToolName | 'Bash' | 'AskUserQuestion';

export type ToolStatus = 'done' | 'failed' | 'rejected' | 'running';

interface FileToolExpectation {
  readonly name: FileToolName;
  readonly target: string;
  readonly status: Exclude<ToolStatus, 'running'>;
}

interface QuestionExpectation {
  readonly name: 'AskUserQuestion';
  readonly target: string;
  readonly status: 'done';
}

interface RejectedCommandExpectation {
  readonly name: 'Bash';
  readonly target: string;
  readonly status: 'rejected';
}

interface EndedCommandExpectation {
  readonly name: 'Bash';
  readonly target: string;
  readonly status: 'done' | 'failed';
  readonly output?: string;
}

interface RunningCommandExpectation {
  readonly name: 'Bash';
  readonly target: string;
  readonly status: 'running';
  readonly output: string;
}

export type ToolExpectation = FileToolExpectation | QuestionExpectation | RejectedCommandExpectation | EndedCommandExpectation | RunningCommandExpectation;

export function wantedOutput(expectation: ToolExpectation): string | undefined {
  return 'output' in expectation ? expectation.output : undefined;
}

export function describeTool(expectation: ToolExpectation): string {
  const output = wantedOutput(expectation);
  const printed = output === undefined ? '' : ` and output ${JSON.stringify(output)}`;
  return `${expectation.name} on ${JSON.stringify(expectation.target)} with status ${expectation.status}${printed}`;
}

export type TaskStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface TaskExpectation {
  readonly description: string;
  readonly status: TaskStatus;
  readonly output?: string;
}

export type ApprovalToolName = Exclude<ToolName, 'Read' | 'AskUserQuestion'>;

export const QUESTION_PENDING = 'a question is pending; answer it with answer() or dismissQuestion() first';

export const APPROVAL_PENDING = 'an approval is pending; answer it with approve() or reject() first';

export interface ChangedLines {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

interface CommandOrWriteApproval {
  readonly name: Exclude<ApprovalToolName, 'Edit'>;
  readonly target: string;
}

interface EditApproval {
  readonly name: 'Edit';
  readonly target: string;
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
}

export type ApprovalExpectation = CommandOrWriteApproval | EditApproval;

export function wantedChanges(expectation: ApprovalExpectation): ChangedLines {
  return expectation.name === 'Edit' ? { added: expectation.added ?? [], removed: expectation.removed ?? [] } : { added: [], removed: [] };
}

export function describeApproval(expectation: ApprovalExpectation): string {
  const { added, removed } = wantedChanges(expectation);
  const lines = [...added.map((line) => `+${JSON.stringify(line)}`), ...removed.map((line) => `-${JSON.stringify(line)}`)];
  return `${expectation.name} on ${JSON.stringify(expectation.target)}${lines.length === 0 ? '' : ` changing ${lines.join(' ')}`}`;
}

export function missingChanges(expectation: ApprovalExpectation, shown: ChangedLines): string[] {
  const { added, removed } = wantedChanges(expectation);
  return [
    ...added.filter((line) => !shown.added.includes(line)).map((line) => `${JSON.stringify(line)} as an added line`),
    ...removed.filter((line) => !shown.removed.includes(line)).map((line) => `${JSON.stringify(line)} as a removed line`),
  ];
}

export function describeChanges({ added, removed }: ChangedLines): string {
  const lines = [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)];
  return lines.length === 0 ? '(no changed lines)' : lines.join('\n');
}

function slashed(path: string): string {
  return path.replaceAll('\\', '/');
}

export function namesFile(shown: string, target: string, workspace: string): boolean {
  if (shown === target || shown.endsWith(` ${target}`)) return true;
  const roots = [workspace, realpathSync.native(workspace)];
  return roots.some((root) => slashed(shown).endsWith(slashed(join(root, target))));
}

export interface ApproveOptions {
  readonly for: 'session';
}

export type PermissionMode = 'manual' | 'yolo' | 'auto';

export type WindowSize = 'normal' | 'narrow';

export const PERMISSION_MODE_NAMES: Readonly<Record<PermissionMode, string>> = {
  manual: 'Always Ask',
  yolo: 'Ask When Needed',
  auto: 'Never Ask',
};

interface VerbSignatures {
  send(text: string): Promise<void>;
  queue(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  steerQueued(): Promise<void>;
  background(): Promise<void>;
  expectTask(expectation: TaskExpectation): Promise<void>;
  stopTask(description: string): Promise<void>;
  approve(options?: ApproveOptions): Promise<void>;
  reject(): Promise<void>;
  rejectWithFeedback(feedback: string): Promise<void>;
  expectApproval(expectation: ApprovalExpectation): Promise<void>;
  answer(option: string): Promise<void>;
  answerOther(text: string): Promise<void>;
  dismissQuestion(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  chooseModel(name: string): Promise<void>;
  setThinking(level: string): Promise<void>;
  setDefaultPermissionMode(mode: PermissionMode): Promise<void>;
  stop(): Promise<void>;
  expectStopped(): Promise<void>;
  waitIdle(): Promise<void>;
  waitForUsageUpdates(count: number): Promise<void>;
  expectTool(expectation: ToolExpectation): Promise<void>;
  expectReply(text: string): Promise<void>;
  expectError(text: string): Promise<void>;
  expectAbsent(text: string): Promise<void>;
  continue(): Promise<void>;
  restart(): Promise<void>;
  restartDuringTurn(): Promise<void>;
  undo(): Promise<void>;
  recallPrevious(): Promise<void>;
  submit(text: string): Promise<void>;
  expectComposer(text: string): Promise<void>;
  newSession(): Promise<void>;
  compact(): Promise<void>;
  resize(size: WindowSize): Promise<void>;
  reload(): Promise<void>;
  expectTranscript(text: string): Promise<void>;
  exit(): Promise<void>;
  expectTerminalRestored(): Promise<void>;
}

export type Actions = { readonly [Name in Verb]: VerbSignatures[Name] };

export type ProductOn<S extends Surface> = { readonly [Name in Verb as [S] extends [SurfacesOf<Name>] ? Name : never]: VerbSignatures[Name] };

export type Product = ProductOn<Surface>;

export type Diagnostic = { readonly name: string; readonly body: string } | { readonly name: string; readonly path: string };

export class StartupFailure extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(cause: unknown, diagnostics: readonly Diagnostic[], message = cause instanceof Error ? cause.message : String(cause)) {
    super(message, { cause });
    this.diagnostics = diagnostics;
  }
}

export type Frame = { readonly kind: 'image'; readonly png: Buffer } | { readonly kind: 'text'; readonly text: string };

type SessionVerb = { [Name in Verb]: (typeof VERBS)[Name] extends { readonly bySession: true } ? Name : never }[Verb];

export interface ReopenState {
  readonly sessionId?: string;
  readonly port?: string;
  readonly size?: WindowSize;
}

export interface Reopen {
  readonly launch: number;
  readonly lastPrompt: string | undefined;
  readonly state: ReopenState;
}

export interface SurfaceControls {
  idle(): Promise<boolean>;
  reopenState(): ReopenState;
  frame(): Promise<Frame>;
  close(): Promise<void>;
  quitDuringTurn(): Promise<void>;
  kill(): Promise<void>;
  networkViolations(): Promise<readonly string[]>;
  diagnostics(): Promise<readonly Diagnostic[]>;
}

export type DriverActionsOn<S extends Surface> = Omit<ProductOn<S>, SessionVerb>;

export type SurfaceDriver<S extends Surface> = DriverActionsOn<S> & SurfaceControls;

export interface EditorMcpServer {
  readonly name: string;
  readonly url: string;
}

export interface SurfaceLaunch {
  readonly home: TestHome;
  readonly model: FakeModel;
  readonly workspaceTrust?: 'trust' | 'exit';
  readonly reopen?: Reopen;
  readonly variant?: Variant;
  readonly editorMcpServers?: readonly EditorMcpServer[];
}
