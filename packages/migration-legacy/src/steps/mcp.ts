import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { McpServerConfigSchema } from '../legacy-config.js';
import { atomicWrite } from '../atomic-write.js';
import { siblingMcpJson, sourceMcpJson, targetMcpFile } from '../paths.js';

export interface McpStepInput {
  readonly sourceHome: string;
  readonly targetHome: string;
}

export interface McpStepResult {
  readonly mergedServers: readonly string[];
  readonly keptNewForConflicts: readonly string[];
  /** Source servers dropped because kimi-code's MCP schema rejects them. */
  readonly droppedServers: readonly string[];
  /** Target `mcp.json` existed but was unparseable; output went to a sibling. */
  readonly wroteSiblingDueToConflict: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function migrateMcpStep(input: McpStepInput): Promise<McpStepResult> {
  let sourceText: string;
  try {
    sourceText = await readFile(sourceMcpJson(input.sourceHome), 'utf-8');
  } catch {
    return { mergedServers: [], keptNewForConflicts: [], droppedServers: [], wroteSiblingDueToConflict: false };
  }

  let sourceJson: unknown;
  try {
    sourceJson = JSON.parse(sourceText);
  } catch {
    return { mergedServers: [], keptNewForConflicts: [], droppedServers: [], wroteSiblingDueToConflict: false };
  }
  const srcServers: Record<string, unknown> = {};
  if (isRecord(sourceJson)) {
    const raw = sourceJson['mcpServers'];
    if (isRecord(raw)) {
      for (const [name, srv] of Object.entries(raw)) {
        srcServers[name] = srv;
      }
    }
  }

  const mergedTargetServers: Record<string, unknown> = {};
  let targetText: string | undefined;
  try {
    targetText = await readFile(targetMcpFile(input.targetHome), 'utf-8');
  } catch {
    targetText = undefined; // absent — start fresh
  }
  let targetUnparseable = false;
  if (targetText !== undefined) {
    try {
      const parsed: unknown = JSON.parse(targetText);
      if (isRecord(parsed)) {
        const raw = parsed['mcpServers'];
        if (isRecord(raw)) {
          for (const [name, srv] of Object.entries(raw)) {
            mergedTargetServers[name] = srv;
          }
        }
      }
    } catch {
      // The target mcp.json exists but is malformed. Overwriting it would
      // silently destroy the user's existing servers — write the migrated
      // servers to a sibling and leave the original untouched.
      targetUnparseable = true;
    }
  }

  const mergedServers: string[] = [];
  const keptNewForConflicts: string[] = [];
  const droppedServers: string[] = [];

  for (const [name, srv] of Object.entries(srcServers)) {
    // A server kimi-code's MCP schema rejects would break every session
    // (resolveSessionMcpConfig parses all entries on create/resume) — drop it.
    if (!McpServerConfigSchema.safeParse(srv).success) {
      droppedServers.push(name);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(mergedTargetServers, name)) {
      keptNewForConflicts.push(name);
    } else {
      mergedTargetServers[name] = srv;
      mergedServers.push(name);
    }
  }

  const outPath = targetUnparseable
    ? siblingMcpJson(input.targetHome)
    : targetMcpFile(input.targetHome);
  await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
  await atomicWrite(outPath, JSON.stringify({ mcpServers: mergedTargetServers }, null, 2));

  return { mergedServers, keptNewForConflicts, droppedServers, wroteSiblingDueToConflict: targetUnparseable };
}
