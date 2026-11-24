import type { TestHome } from '@moonshot-ai/testkit/fixtures';
import type { FakeModel } from '@moonshot-ai/testkit/model';

export const VERBS = ['send', 'approve', 'reject', 'stop', 'waitIdle', 'expectTool', 'expectReply'] as const;

export type Verb = (typeof VERBS)[number];

export const SURFACES = ['tui', 'acp', 'desktop', 'web'] as const;

export type Surface = (typeof SURFACES)[number];

export type ToolName = 'Read' | 'Edit' | 'Write' | 'Bash';

export type ToolStatus = 'done' | 'failed' | 'rejected' | 'running';

interface FileToolExpectation {
  readonly name: Exclude<ToolName, 'Bash'>;
  readonly target: string;
  readonly status: Exclude<ToolStatus, 'running'>;
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

export type ToolExpectation = FileToolExpectation | RejectedCommandExpectation | EndedCommandExpectation | RunningCommandExpectation;

export function wantedOutput(expectation: ToolExpectation): string | undefined {
  return 'output' in expectation ? expectation.output : undefined;
}

export function describeTool(expectation: ToolExpectation): string {
  const output = wantedOutput(expectation);
  const printed = output === undefined ? '' : ` and output ${JSON.stringify(output)}`;
  return `${expectation.name} on ${JSON.stringify(expectation.target)} with status ${expectation.status}${printed}`;
}

interface VerbSignatures {
  send(text: string): Promise<void>;
  approve(): Promise<void>;
  reject(): Promise<void>;
  stop(): Promise<void>;
  waitIdle(): Promise<void>;
  expectTool(expectation: ToolExpectation): Promise<void>;
  expectReply(text: string): Promise<void>;
}

export type Product = { readonly [Name in Verb]: VerbSignatures[Name] };

export type Diagnostic = { readonly name: string; readonly body: string } | { readonly name: string; readonly path: string };

export type Frame = { readonly kind: 'image'; readonly png: Buffer } | { readonly kind: 'text'; readonly text: string };

export interface SurfaceDriver extends Product {
  frame(): Promise<Frame>;
  close(): Promise<void>;
  kill(): Promise<void>;
  networkViolations(): Promise<readonly string[]>;
  diagnostics(): Promise<readonly Diagnostic[]>;
}

export interface SurfaceLaunch {
  readonly home: TestHome;
  readonly model: FakeModel;
}
