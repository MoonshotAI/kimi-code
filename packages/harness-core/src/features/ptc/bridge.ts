import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PtcContextBridge } from './context';

export interface PtcBridge {
  readonly tools: Record<string, (args: unknown) => Promise<string>>;
  readonly console: Record<'log' | 'info' | 'warn' | 'error', (...values: unknown[]) => void>;
  readonly detach: (text: string) => void;
  readonly context?: PtcContextBridge;
}

export interface PtcRunOutcome {
  readonly value?: unknown;
}

interface BridgeRegistry {
  readonly bridges: Map<string, PtcBridge>;
}

declare global {
  var __ptc_bridge_registry__: BridgeRegistry | undefined;
}

function registry(): BridgeRegistry {
  globalThis.__ptc_bridge_registry__ ??= { bridges: new Map() };
  return globalThis.__ptc_bridge_registry__;
}

export function createStdoutCapture(maxBytes: number): {
  readonly console: PtcBridge['console'];
  read(): string;
} {
  let buffer = '';
  const append = (values: unknown[]): void => {
    const line = values
      .map((value) => (typeof value === 'string' ? value : safeStringify(value)))
      .join(' ');
    buffer = (buffer + line + '\n').slice(-maxBytes);
  };
  return {
    console: {
      log: (...values) => append(values),
      info: (...values) => append(values),
      warn: (...values) => append(values),
      error: (...values) => append(values),
    },
    read: () => buffer.trimEnd(),
  };
}

export function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text ?? String(value);
  } catch {
    return String(value);
  }
}

export function truncate(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  return `${text.slice(-maxBytes)}\n(stdout truncated to last ${maxBytes} chars)`;
}

const SHIM = `const bridge = globalThis.__ptc_bridge_registry__.bridges.get(__PTC_EXEC_ID__);
if (bridge === undefined) throw new Error('ptc bridge is not registered');
export const tools = bridge.tools;
export const console = bridge.console;
export const detach = bridge.detach;
__PTC_CONTEXT__`;

const SHIM_CONTEXT = `export const useAgent = bridge.context.useAgent;
export const useAgentStore = bridge.context.useAgentStore;
export const useBlobs = bridge.context.useBlobs;
export const useSession = bridge.context.useSession;
`;

export async function runPtcProgram(opts: {
  readonly dir: string;
  readonly execId: string;
  readonly code: string;
  readonly bridge: PtcBridge;
  readonly signal: AbortSignal;
}): Promise<PtcRunOutcome> {
  const runDir = join(opts.dir, opts.execId);
  await mkdir(runDir, { recursive: true });
  const shim = SHIM.replace('__PTC_EXEC_ID__', JSON.stringify(opts.execId)).replace(
    '__PTC_CONTEXT__',
    opts.bridge.context === undefined ? '' : SHIM_CONTEXT,
  );
  await writeFile(join(runDir, 'tools.mjs'), shim);
  const imports =
    opts.bridge.context === undefined
      ? `import { tools, console, detach } from './tools.mjs';\nvoid tools; void console; void detach;`
      : `import { tools, console, detach, useAgent, useAgentStore, useBlobs, useSession } from './tools.mjs';\nvoid tools; void console; void detach; void useAgent; void useAgentStore; void useBlobs; void useSession;`;
  const program = [
    imports,
    `export default async function main() {`,
    opts.code,
    `}`,
    ``,
  ].join('\n');
  await writeFile(join(runDir, 'program.mjs'), program);
  registry().bridges.set(opts.execId, opts.bridge);
  try {
    const run = async (): Promise<PtcRunOutcome> => {
      const mod = (await import(pathToFileURL(join(runDir, 'program.mjs')).href)) as {
        default: () => Promise<unknown>;
      };
      const value = await mod.default();
      return { value };
    };
    return await Promise.race([run(), aborted(opts.signal)]);
  } finally {
    opts.bridge.context?.drain();
    registry().bridges.delete(opts.execId);
  }
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(toError(signal.reason));
      return;
    }
    signal.addEventListener('abort', () => reject(toError(signal.reason)), { once: true });
  });
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('aborted');
}
