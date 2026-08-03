import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { parseAgentFileText, resolveAgentPath } from '@moonshot-ai/kimi-code-sdk';

import type { CLIOptions } from './options';

/**
 * Resolve which agent profile the launch flags select.
 *
 * `--agent` carries the profile name directly; `--agent-file` implicitly
 * selects the profile the file defines, so the file is parsed here (fatal on
 * error) so a bad file fails before any session work. Returns undefined when
 * neither flag is present.
 */
export async function resolveAgentProfileSelection(
  opts: Pick<CLIOptions, 'agent' | 'agentFiles'>,
  workDir: string,
): Promise<string | undefined> {
  if (opts.agent !== undefined) return opts.agent;
  const agentFile = opts.agentFiles?.[0];
  if (agentFile === undefined) return undefined;

  const path = resolveAgentPath(agentFile, workDir, homedir());
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read agent file "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    return parseAgentFileText({ path, source: 'explicit', text }).name;
  } catch (error) {
    throw new Error(
      `Invalid agent file "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
