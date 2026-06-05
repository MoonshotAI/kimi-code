import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { writeAtomicJsonFile } from './atomic-file';

export type HeadlessRunState =
  | 'starting'
  | 'running'
  | 'approval_required'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface HeadlessRunSummary {
  readonly turnStepCount: number;
  readonly toolCallCount: number;
  readonly completedToolCallCount: number;
  readonly failedToolCallCount: number;
  readonly assistantCharCount: number;
  readonly thinkingCharCount: number;
}

export interface HeadlessActiveToolStatus {
  readonly toolCallId: string;
  readonly name: string;
  readonly description?: string;
}

export interface HeadlessApprovalStatus {
  readonly kind: 'plan';
  readonly toolCallId?: string;
  readonly decision: 'required' | 'approved' | 'rejected';
  readonly decidedByFlag: 'approve-plan' | 'reject-plan' | null;
  readonly message: string;
}

export interface HeadlessGoalStatus {
  readonly goalId: string | null;
  readonly status: string | null;
  readonly reason: string | null;
  readonly turnsUsed: number | null;
  readonly tokensUsed: number | null;
  readonly wallClockMs: number | null;
}

export interface HeadlessWarning {
  readonly code: string;
  readonly message: string;
}

export type HeadlessOutputFileState = 'writing' | 'completed' | 'failed';

export interface HeadlessResponseFile {
  readonly turnIndex: number;
  readonly turnId: number | null;
  readonly path: string;
  readonly state: HeadlessOutputFileState;
  readonly bytes: number | null;
  readonly updatedAt: string;
}

export interface HeadlessSidecarFile {
  readonly path: string;
  readonly state: HeadlessOutputFileState;
  readonly bytes: number | null;
  readonly updatedAt: string;
}

export interface HeadlessRunFiles {
  readonly outputDir: string | null;
  readonly responses: readonly HeadlessResponseFile[];
  readonly finalResponse: HeadlessResponseFile | null;
  readonly goalStatus: HeadlessSidecarFile | null;
}

export type HeadlessControlAction = 'pause_goal' | 'cancel_goal' | 'interrupt';

export interface HeadlessControlRequest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly commandId: string;
  readonly action: HeadlessControlAction;
  readonly requestedAt: string;
}

export interface HeadlessAppliedControlRequest {
  readonly commandId: string;
  readonly action: HeadlessControlAction;
  readonly appliedAt: string;
  readonly result: 'applied' | 'failed';
  readonly error?: { readonly message: string };
}

export interface HeadlessRunControl {
  readonly path: string;
  readonly supportedActions: readonly HeadlessControlAction[];
  readonly lastRequest: HeadlessControlRequest | null;
  readonly lastApplied: HeadlessAppliedControlRequest | null;
}

export interface HeadlessRunStatus {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly pid: number;
  readonly sessionId: string | null;
  readonly turnId: number | null;
  readonly state: HeadlessRunState;
  readonly workDir: string;
  readonly model: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly elapsedMs: number;
  readonly lastEvent: string | null;
  readonly activeTool: HeadlessActiveToolStatus | null;
  readonly summary: HeadlessRunSummary;
  readonly approval: HeadlessApprovalStatus | null;
  readonly goal: HeadlessGoalStatus | null;
  readonly warnings: readonly HeadlessWarning[];
  readonly files: HeadlessRunFiles;
  readonly control: HeadlessRunControl | null;
  readonly error: { readonly message: string } | null;
  readonly resumeCommand: string | null;
}

export async function preflightHeadlessStatusFile(filePath: string): Promise<void> {
  const parent = path.dirname(filePath);
  let parentStat;
  try {
    parentStat = await stat(parent);
  } catch {
    throw new Error('Status file parent directory does not exist.');
  }
  if (!parentStat.isDirectory()) {
    throw new Error('Status file parent path is not a directory.');
  }
  try {
    await access(parent, constants.W_OK);
  } catch {
    throw new Error('Status file parent directory is not writable.');
  }
}

export async function writeHeadlessRunStatus(
  filePath: string,
  status: HeadlessRunStatus,
): Promise<void> {
  await writeAtomicJsonFile(filePath, status);
}

export async function readHeadlessRunStatus(filePath: string): Promise<HeadlessRunStatus> {
  return JSON.parse(await readFile(filePath, 'utf8')) as HeadlessRunStatus;
}
