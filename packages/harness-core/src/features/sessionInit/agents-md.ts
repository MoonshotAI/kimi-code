import { join } from 'pathe';

import { loadAgentsMdPaths } from '#/features/agentsMdReminder/index';
import type { OsHost } from '#/features/os/host/index';

export interface LoadedAgentsMd {
  readonly content: string;
  readonly paths: string[];
}

export async function loadAgentsMdDetailed(
  host: OsHost,
  workDir: string,
  brandHome?: string,
): Promise<LoadedAgentsMd> {
  await host.environment.ready;
  const homeDir = host.environment.homeDir;
  const paths = await loadAgentsMdPaths(
    { fs: host.fs, homeDir },
    workDir,
    brandHome ?? join(homeDir, '.kimi-code'),
  );
  const sections: string[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = (await host.fs.readText(path, { errors: 'ignore' })).trim();
    } catch {
      continue;
    }
    if (text.length === 0) continue;
    sections.push(`<!-- From: ${path} -->\n${text}`);
  }
  return { content: sections.join('\n\n'), paths };
}
