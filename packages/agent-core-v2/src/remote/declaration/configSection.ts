import type { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { camelToSnake, isPlainObject, transformPlainObject } from '#/app/config/toml';

import {
  EnvironmentsSectionSchema,
  sectionEntries,
  type EnvironmentDeclarationSet,
  type EnvironmentsSection,
} from './remoteEnvironmentDeclaration';

export const ENVIRONMENTS_SECTION = 'environments';

export function environmentsFromToml(rawSnake: unknown): unknown {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawSnake)) {
    out[key] = isPlainObject(value) ? transformPlainObject(value) : value;
  }
  const defaultId = out['default'];
  if (typeof defaultId === 'string' && !(defaultId in out)) {
    const snakeId = camelToSnake(defaultId);
    if (snakeId !== 'default' && snakeId in out) out['default'] = snakeId;
  }
  return out;
}

registerConfigSection(ENVIRONMENTS_SECTION, EnvironmentsSectionSchema, {
  fromToml: environmentsFromToml,
  toToml: (value) => value,
});

export async function resolveWorkspaceEnvironmentDeclarations(
  config: IConfigService,
): Promise<EnvironmentDeclarationSet> {
  await config.ready;
  config.assertValid(ENVIRONMENTS_SECTION);
  const user = config.get<EnvironmentsSection | undefined>(ENVIRONMENTS_SECTION);
  const entries = sectionEntries(user);
  return { entries, defaultId: user?.default };
}
