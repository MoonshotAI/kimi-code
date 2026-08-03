/**
 * Shared host helpers for capability entries: process execution with
 * captured output, and streaming downloads with progress reporting.
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { IHostProcessService } from '#/os/interface/hostProcess';

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Spawn a command and capture its output. Never throws for a non-zero exit —
 * the caller interprets `code`. A spawn failure (missing binary) resolves to
 * `code: -1` with the error message in `stderr`.
 */
export async function runCommand(
  hostProcess: IHostProcessService,
  command: string,
  args: readonly string[],
  options: { timeout?: number } = {},
): Promise<CommandResult> {
  const spawned = await hostProcess.spawn(command, args, { windowsHide: true }).then(
    (proc) => ({ ok: true as const, proc }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!spawned.ok) {
    return { code: -1, stdout: '', stderr: spawned.error instanceof Error ? spawned.error.message : String(spawned.error) };
  }
  const { proc } = spawned;
  try {
    const work = Promise.all([
      collect(proc.stdout),
      collect(proc.stderr),
      proc.wait().catch(() => -1),
    ] as const);
    let timer: NodeJS.Timeout | undefined;
    const timed = options.timeout === undefined
      ? work
      : Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              void proc.kill().catch(() => {});
              reject(new Error(`command timed out after ${options.timeout}ms: ${command}`));
            }, options.timeout);
            timer.unref?.();
          }),
        ]);
    try {
      const [stdout, stderr, code] = await timed;
      return { code, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } finally {
    proc.dispose();
  }
}

export type FetchLike = (
  url: string,
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: import('node:stream/web').ReadableStream | null;
}>;

/**
 * Download `url` to `destPath` (parent dirs created), reporting 0–99 percent
 * while the response carries a content-length. Returns the byte count.
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  onPercent?: (percent: number) => void,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<number> {
  const resp = await fetchImpl(url);
  if (!resp.ok || resp.body === null) {
    throw new Error(`Failed to download ${url}: HTTP ${resp.status}`);
  }
  const total = Number(resp.headers.get('content-length') ?? 0);
  await mkdir(path.dirname(destPath), { recursive: true });
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (total > 0 && onPercent !== undefined) {
        onPercent(Math.min(99, Math.floor((received / total) * 100)));
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(resp.body), meter, createWriteStream(destPath));
  onPercent?.(100);
  return received;
}
