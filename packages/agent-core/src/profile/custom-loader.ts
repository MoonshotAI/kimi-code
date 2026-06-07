import { readdir, readFile } from 'node:fs/promises';
import { join } from 'pathe';

import { DEFAULT_INIT_PROMPT, DEFAULT_PROFILE_PATHS, PROFILE_SOURCES } from './default';
import { loadAgentProfilesFromSources } from './load';
import type { ResolvedAgentProfile } from './types';

export async function loadCustomAgentProfiles(
  dir: string,
): Promise<{ profiles: Record<string, ResolvedAgentProfile>; initPrompt: string }> {
  const entries = await readdir(dir);
  const customSources: Record<string, string> = {};
  const customPaths: string[] = [];

  for (const file of ['agent.yaml']) {
    if (!entries.includes(file)) continue;
    const content = await readFile(join(dir, file), 'utf-8');
    const sourcePath = `profile/default/${file}`;
    customSources[sourcePath] = content;
    customPaths.push(sourcePath);
  }

  for (const file of ['system.md']) {
    if (entries.includes(file)) {
      customSources[`profile/default/${file}`] = await readFile(join(dir, file), 'utf-8');
    }
  }

  const mergedSources = { ...PROFILE_SOURCES, ...customSources };
  const allPaths = [...new Set([...DEFAULT_PROFILE_PATHS, ...customPaths])];

  const profiles = loadAgentProfilesFromSources(allPaths, mergedSources);

  let initPrompt = DEFAULT_INIT_PROMPT;
  if (entries.includes('init.md')) {
    initPrompt = await readFile(join(dir, 'init.md'), 'utf-8');
  }

  return { profiles, initPrompt };
}
