import { access, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeAtomicJsonFile, writeAtomicTextFile } from './atomic-file';
import type { HeadlessGoalStatus, HeadlessResponseFile, HeadlessSidecarFile } from './status-file';

export interface ResolveHeadlessOutputDirInput {
  readonly explicitOutputDir?: string;
  readonly statusFile?: string;
  readonly runId: string;
}

export function resolveHeadlessOutputDir(input: ResolveHeadlessOutputDirInput): string {
  if (input.explicitOutputDir !== undefined) return path.resolve(input.explicitOutputDir);
  if (input.statusFile !== undefined) return path.resolve(`${input.statusFile}.d`);
  return path.join(tmpdir(), `kimi-headless-${input.runId}`);
}

export async function preflightHeadlessOutputDir(outputDir: string): Promise<void> {
  try {
    const existing = await stat(outputDir);
    if (!existing.isDirectory()) {
      throw new Error('Output path exists and is not a directory.');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Output path exists and is not a directory.') {
      throw error;
    }
    await mkdir(outputDir, { recursive: true });
  }

  try {
    await access(outputDir, constants.W_OK);
  } catch {
    throw new Error('Output directory is not writable.');
  }
  await mkdir(path.join(outputDir, 'turns'), { recursive: true });
}

export async function writeHeadlessResponseFile(input: {
  readonly outputDir: string;
  readonly turnIndex: number;
  readonly turnId: number | null;
  readonly markdown: string;
  readonly updatedAt: string;
}): Promise<HeadlessResponseFile> {
  const filePath = path.join(input.outputDir, 'turns', `turn-${padTurnIndex(input.turnIndex)}.md`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeAtomicTextFile(filePath, input.markdown);
  return {
    turnIndex: input.turnIndex,
    turnId: input.turnId,
    path: filePath,
    state: 'completed',
    bytes: Buffer.byteLength(input.markdown, 'utf8'),
    updatedAt: input.updatedAt,
  };
}

export async function writeHeadlessGoalStatusFile(input: {
  readonly outputDir: string;
  readonly goal: HeadlessGoalStatus;
  readonly updatedAt: string;
}): Promise<HeadlessSidecarFile> {
  const filePath = path.join(input.outputDir, 'goal-status.json');
  await writeAtomicJsonFile(filePath, input.goal);
  const json = `${JSON.stringify(input.goal, null, 2)}\n`;
  return {
    path: filePath,
    state: 'completed',
    bytes: Buffer.byteLength(json, 'utf8'),
    updatedAt: input.updatedAt,
  };
}

function padTurnIndex(turnIndex: number): string {
  return String(turnIndex).padStart(4, '0');
}
