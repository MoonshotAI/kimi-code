import { describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import { resolveWorkspaceEnvironmentDeclarations } from '#/environment/environmentDeclarations';
import { EnvironmentsSectionSchema, type EnvironmentsSection } from '#/environment/remoteEnvironmentDeclaration';

function fakeConfig(section: EnvironmentsSection | undefined): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: (domain: string) => (domain === 'environments' ? section : undefined),
  } as unknown as IConfigService;
}

const USER_TOML: EnvironmentsSection = EnvironmentsSectionSchema.parse({
  default: 'user-box',
  'user-box': { type: 'ssh', host: 'user-box', defaultCwd: '/home/me/user' },
  shared: { type: 'ssh', host: 'user-shared', defaultCwd: '/home/me/shared' },
});

describe('resolveWorkspaceEnvironmentDeclarations', () => {
  it('resolves user declarations from the [environments] section', async () => {
    const resolved = await resolveWorkspaceEnvironmentDeclarations(fakeConfig(USER_TOML));
    expect(resolved.entries.map((entry) => entry.id).toSorted()).toEqual(['shared', 'user-box']);
    expect(resolved.default).toEqual({ environmentId: 'user-box', cwd: '/home/me/user' });
  });

  it('yields no entries and no default without a section', async () => {
    const resolved = await resolveWorkspaceEnvironmentDeclarations(fakeConfig(undefined));
    expect(resolved.entries).toEqual([]);
    expect(resolved.default).toBeUndefined();
  });
});
