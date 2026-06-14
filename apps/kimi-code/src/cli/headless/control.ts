import { readFile } from 'node:fs/promises';

import { writeAtomicJsonFile } from './atomic-file';
import {
  readHeadlessRunStatus,
  type HeadlessAppliedControlRequest,
  type HeadlessControlRequest,
} from './status-file';

export async function writeHeadlessControlRequest(
  controlPath: string,
  request: HeadlessControlRequest,
): Promise<void> {
  await writeAtomicJsonFile(controlPath, request);
}

export async function readHeadlessControlRequest(
  controlPath: string,
): Promise<HeadlessControlRequest | null> {
  try {
    return JSON.parse(await readFile(controlPath, 'utf8')) as HeadlessControlRequest;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function waitForHeadlessControlApplied(input: {
  readonly statusFile: string;
  readonly commandId: string;
  readonly timeoutMs: number;
}): Promise<HeadlessAppliedControlRequest | null> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() <= deadline) {
    const status = await readHeadlessRunStatus(input.statusFile);
    const applied = status.control?.lastApplied;
    if (applied?.commandId === input.commandId) return applied;
    if (isTerminalState(status.state)) return null;
    await delay(100);
  }
  return null;
}

function isTerminalState(state: string): boolean {
  return ['paused', 'completed', 'failed', 'cancelled', 'interrupted'].includes(state);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
