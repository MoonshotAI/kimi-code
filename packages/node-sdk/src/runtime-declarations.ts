/**
 * Project-scope runtime declaration writes (`<root>/.kimi-code/runtimes.toml`).
 * The file is shared through git, so merges go through the engine's
 * formatting-preserving TOML writeback planner: existing entries, comments,
 * and layout survive; a full re-serialize is only the fallback (and the
 * initial write). Every failure mode is closed — an unreadable, invalid, or
 * duplicate-id file is left untouched, because the declaration watch would
 * otherwise pick up a half-merged file.
 */

import { dirname, join } from 'node:path';

import { planConfigWriteback } from '@moonshot-ai/agent-core-v2/app/config/tomlWriteback';
import type { IHostFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '@moonshot-ai/agent-core-v2/os/interface/hostFsErrors';
import {
  PROJECT_RUNTIMES_FILE,
  RuntimesSectionSchema,
  type RemoteRuntimeEntry,
} from '@moonshot-ai/agent-core-v2';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { ErrorCodes, KimiError } from '#/errors';

export async function writeProjectRuntimeDeclaration(
  fs: IHostFileSystem,
  root: string,
  id: string,
  entry: RemoteRuntimeEntry,
): Promise<void> {
  const filePath = join(root, PROJECT_RUNTIMES_FILE);
  const onDiskText = await readProjectRuntimesText(fs, filePath);
  const previous = parseProjectRuntimes(onDiskText, filePath);
  if (previous[id] !== undefined) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Runtime id "${id}" is already declared in ${filePath}.`,
    );
  }
  const nextEntry = stripUndefined(entry) as RemoteRuntimeEntry;
  const merged = { ...previous, [id]: nextEntry };
  const validation = RuntimesSectionSchema.safeParse(merged);
  if (!validation.success) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid runtimes in ${filePath}: ${validation.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  const planned =
    onDiskText === undefined
      ? undefined
      : planConfigWriteback(
          onDiskText,
          [{ snakeKey: id, previousValue: undefined, nextValue: nextEntry }],
          merged,
        );
  const text = planned ?? stringifyToml(merged);
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeText(filePath, text.endsWith('\n') ? text : `${text}\n`);
}

async function readProjectRuntimesText(
  fs: IHostFileSystem,
  filePath: string,
): Promise<string | undefined> {
  try {
    return await fs.readText(filePath);
  } catch (error: unknown) {
    if (error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND) {
      return undefined;
    }
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function parseProjectRuntimes(
  text: string | undefined,
  filePath: string,
): Record<string, unknown> {
  if (text === undefined || text.trim().length === 0) return {};
  let data: unknown;
  try {
    data = parseToml(text);
  } catch (error: unknown) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid TOML in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid runtimes in ${filePath}: not a table`);
  }
  return data as Record<string, unknown>;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested !== undefined) out[key] = stripUndefined(nested);
    }
    return out;
  }
  return value;
}
