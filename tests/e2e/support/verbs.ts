import type { TestHome } from '@moonshot-ai/testkit/fixtures';
import type { FakeModel } from '@moonshot-ai/testkit/model';

export const VERBS = ['send', 'approve', 'reject', 'stop', 'waitIdle', 'expectTool', 'expectReply'] as const;

export type Verb = (typeof VERBS)[number];

export const SURFACES = ['tui', 'acp', 'desktop', 'web'] as const;

export type Surface = (typeof SURFACES)[number];

export type ToolName = 'Read' | 'Edit' | 'Write' | 'Bash';

export type ToolStatus = 'done' | 'failed' | 'rejected';

export interface ToolExpectation {
  readonly name: ToolName;
  readonly target: string;
  readonly status: ToolStatus;
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

export interface Diagnostic {
  readonly name: string;
  readonly body: string;
}

export interface SurfaceDriver extends Product {
  close(): Promise<void>;
  kill(): Promise<void>;
  networkViolations(): Promise<readonly string[]>;
  diagnostics(): Promise<readonly Diagnostic[]>;
}

export interface SurfaceLaunch {
  readonly home: TestHome;
  readonly model: FakeModel;
}
