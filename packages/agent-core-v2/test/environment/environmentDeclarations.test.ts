import { describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  loadProjectEnvironmentsSection,
  previewProjectEnvironmentDeclarations,
  resolveWorkspaceEnvironmentDeclarations,
  writeProjectEnvironmentDeclaration,
} from '#/environment/environmentDeclarations';
import { EnvironmentsSectionSchema, type EnvironmentsSection } from '#/environment/remoteEnvironmentDeclaration';
import { writeWorkspaceTrust } from '#/workspace/workspaceTrust/trustRecord';

function fakeFs(files: Readonly<Record<string, string>>): IHostFileSystem {
  return {
    _serviceBrand: undefined,
    readText: async (path: string) => {
      const text = files[path];
      if (text === undefined) {
        throw new HostFsError(OsFsErrors.codes.OS_FS_NOT_FOUND, `not found: ${path}`);
      }
      return text;
    },
  } as unknown as IHostFileSystem;
}

function fakeConfig(section: EnvironmentsSection | undefined): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: (domain: string) => (domain === 'environments' ? section : undefined),
  } as unknown as IConfigService;
}

function fakeDocs(): IAtomicDocumentStore & { readonly records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  return {
    _serviceBrand: undefined,
    records,
    get: async <T,>(scope: string, key: string) => records.get(`${scope}/${key}`) as T | undefined,
    set: async <T,>(scope: string, key: string, value: T) => {
      records.set(`${scope}/${key}`, value);
    },
    delete: async (scope: string, key: string) => {
      records.delete(`${scope}/${key}`);
    },
  } as unknown as IAtomicDocumentStore & { readonly records: Map<string, unknown> };
}

const ROOT = '/repo';
const PROJECT_FILE = '/repo/.kimi-code/environments.toml';

const USER_TOML: EnvironmentsSection = EnvironmentsSectionSchema.parse({
  default: 'user-box',
  'user-box': { type: 'ssh', host: 'user-box', defaultCwd: '/home/me/user' },
  shared: { type: 'ssh', host: 'user-shared', defaultCwd: '/home/me/shared' },
});

const PROJECT_TOML = `
default = "project-box"

[project-box]
type = "ssh"
host = "project-box"
defaultCwd = "/home/me/project"

[shared]
type = "ssh"
host = "project-shared"
defaultCwd = "/home/me/project-shared"
`;

describe('loadProjectEnvironmentsSection', () => {
  it('returns undefined when the project file is missing', async () => {
    expect(await loadProjectEnvironmentsSection(fakeFs({}), ROOT)).toBeUndefined();
  });

  it('parses the project file with the shared schema', async () => {
    const section = await loadProjectEnvironmentsSection(fakeFs({ [PROJECT_FILE]: PROJECT_TOML }), ROOT);
    expect(section?.default).toBe('project-box');
    expect(section?.['project-box']).toMatchObject({ type: 'ssh', host: 'project-box' });
  });

  it('rejects invalid TOML and invalid declarations', async () => {
    await expect(
      loadProjectEnvironmentsSection(fakeFs({ [PROJECT_FILE]: 'not = [toml' }), ROOT),
    ).rejects.toMatchObject({ code: 'config.invalid' });
    await expect(
      loadProjectEnvironmentsSection(fakeFs({ [PROJECT_FILE]: '[bad]\ntype = "ssh"\nhost = "x"\ncommand = "y"\n' }), ROOT),
    ).rejects.toMatchObject({ code: 'config.invalid' });
  });
});

describe('resolveWorkspaceEnvironmentDeclarations', () => {
  it('does not load project declarations for an untrusted workspace', async () => {
    const docs = fakeDocs();
    const resolved = await resolveWorkspaceEnvironmentDeclarations({
      config: fakeConfig(USER_TOML),
      fs: fakeFs({ [PROJECT_FILE]: PROJECT_TOML }),
      docs,
      root: ROOT,
    });
    expect(resolved.entries.map((entry) => entry.id).toSorted()).toEqual(['shared', 'user-box']);
    expect(resolved.entries.every((entry) => entry.source === 'user')).toBe(true);
    expect(resolved.default).toEqual({ environmentId: 'user-box', cwd: '/home/me/user' });
  });

  it('loads project declarations for a trusted workspace, overriding same-id user entries', async () => {
    const docs = fakeDocs();
    await writeWorkspaceTrust(docs, ROOT, Date.now());
    const resolved = await resolveWorkspaceEnvironmentDeclarations({
      config: fakeConfig(USER_TOML),
      fs: fakeFs({ [PROJECT_FILE]: PROJECT_TOML }),
      docs,
      root: ROOT,
    });
    const shared = resolved.entries.find((entry) => entry.id === 'shared');
    expect(shared).toMatchObject({ source: 'project', entry: { host: 'project-shared' } });
    expect(resolved.entries.map((entry) => entry.id).toSorted()).toEqual(['project-box', 'shared', 'user-box']);
  });

  it('prefers the project default over the user default, and falls back to none', async () => {
    const docs = fakeDocs();
    await writeWorkspaceTrust(docs, ROOT, Date.now());
    const resolved = await resolveWorkspaceEnvironmentDeclarations({
      config: fakeConfig(USER_TOML),
      fs: fakeFs({ [PROJECT_FILE]: PROJECT_TOML }),
      docs,
      root: ROOT,
    });
    expect(resolved.default).toEqual({ environmentId: 'project-box', cwd: '/home/me/project' });

    const userOnly = await resolveWorkspaceEnvironmentDeclarations({
      config: fakeConfig(USER_TOML),
      fs: fakeFs({}),
      docs,
      root: '/elsewhere',
    });
    expect(userOnly.default).toEqual({ environmentId: 'user-box', cwd: '/home/me/user' });

    const noDefault = await resolveWorkspaceEnvironmentDeclarations({
      config: fakeConfig(undefined),
      fs: fakeFs({}),
      docs,
      root: '/elsewhere',
    });
    expect(noDefault.default).toBeUndefined();
    expect(noDefault.entries).toEqual([]);
  });

  it('takes the default cwd from the merged project entry when the project overrides the user default id', async () => {
    const docs = fakeDocs();
    await writeWorkspaceTrust(docs, ROOT, Date.now());
    const user = EnvironmentsSectionSchema.parse({
      default: 'dev',
      dev: { type: 'ssh', host: 'user-dev', defaultCwd: '/home/me/user-dev' },
    });
    const resolved = await resolveWorkspaceEnvironmentDeclarations({
      config: fakeConfig(user),
      fs: fakeFs({
        [PROJECT_FILE]: `
[dev]
type = "ssh"
host = "project-dev"
defaultCwd = "/home/me/project-dev"
`,
      }),
      docs,
      root: ROOT,
    });
    expect(resolved.entries.find((entry) => entry.id === 'dev')).toMatchObject({ source: 'project' });
    expect(resolved.default).toEqual({ environmentId: 'dev', cwd: '/home/me/project-dev' });
  });

  it('yields no default when the merged winning entry for the default id has no defaultCwd', async () => {
    const docs = fakeDocs();
    await writeWorkspaceTrust(docs, ROOT, Date.now());
    const user = EnvironmentsSectionSchema.parse({
      default: 'dev',
      dev: { type: 'ssh', host: 'user-dev', defaultCwd: '/home/me/user-dev' },
    });
    const resolved = await resolveWorkspaceEnvironmentDeclarations({
      config: fakeConfig(user),
      fs: fakeFs({
        [PROJECT_FILE]: `
[dev]
type = "ssh"
host = "project-dev"
`,
      }),
      docs,
      root: ROOT,
    });
    expect(resolved.entries.find((entry) => entry.id === 'dev')).toMatchObject({ source: 'project' });
    expect(resolved.default).toBeUndefined();
  });
});

describe('previewProjectEnvironmentDeclarations', () => {
  it('lists each declared environment with its full command line for the trust prompt', async () => {
    const preview = await previewProjectEnvironmentDeclarations(
      fakeFs({
        [PROJECT_FILE]: `
[dev-box]
type = "ssh"
host = "dev-box"
defaultCwd = "/home/me"

[gym]
command = "${process.execPath}"
args = ["sandbox", "ssh", "i-1"]
defaultCwd = "/home/me/gym"
`,
      }),
      ROOT,
    );
    expect(preview).toEqual([
      { id: 'dev-box', commandLine: 'ssh dev-box ~/.kimi-code/bin/kimi exec-server --listen stdio' },
      { id: 'gym', commandLine: `${process.execPath} sandbox ssh i-1` },
    ]);
  });

  it('marks command entries that fail resolution instead of hiding them', async () => {
    const preview = await previewProjectEnvironmentDeclarations(
      fakeFs({
        [PROJECT_FILE]: `
[broken]
command = "definitely-not-a-real-binary-xyz"
`,
      }),
      ROOT,
    );
    expect(preview).toHaveLength(1);
    expect(preview[0]!.commandLine).toContain('definitely-not-a-real-binary-xyz');
    expect(preview[0]!.commandLine).toContain('invalid:');
  });
});

describe('writeProjectEnvironmentDeclaration', () => {
  function writableFs(files: Record<string, string>): IHostFileSystem {
    return {
      _serviceBrand: undefined,
      readText: async (path: string) => {
        const text = files[path];
        if (text === undefined) {
          throw new HostFsError(OsFsErrors.codes.OS_FS_NOT_FOUND, `not found: ${path}`);
        }
        return text;
      },
      mkdir: async () => {},
      writeText: async (path: string, text: string) => {
        files[path] = text;
      },
    } as unknown as IHostFileSystem;
  }

  it('writes a new declaration into an empty project file', async () => {
    const files: Record<string, string> = {};
    await writeProjectEnvironmentDeclaration(writableFs(files), ROOT, 'box', { type: 'ssh', host: 'box', defaultCwd: '/remote' });
    const section = await loadProjectEnvironmentsSection(fakeFs(files), ROOT);
    expect(section?.['box']).toMatchObject({ type: 'ssh', host: 'box', defaultCwd: '/remote' });
  });

  it('preserves existing entries and comments on merge and rejects a duplicate id', async () => {
    const files = { [PROJECT_FILE]: '# Team declarations.\n[existing]\ntype = "ssh"\nhost = "existing"\n' };
    const fs = writableFs(files);
    await writeProjectEnvironmentDeclaration(fs, ROOT, 'added', { command: 'added-cmd', defaultCwd: '/remote' });
    expect(files[PROJECT_FILE]).toContain('# Team declarations.');
    expect(files[PROJECT_FILE]).toContain('[existing]');
    expect(files[PROJECT_FILE]).toContain('added-cmd');
    await expect(
      writeProjectEnvironmentDeclaration(fs, ROOT, 'added', { command: 'other-cmd', defaultCwd: '/remote' }),
    ).rejects.toMatchObject({ code: 'config.invalid' });
  });

  it('serializes concurrent declarations so every entry lands', async () => {
    const files: Record<string, string> = {};
    const fs = writableFs(files);
    await Promise.all([
      writeProjectEnvironmentDeclaration(fs, ROOT, 'box-a', { type: 'ssh', host: 'box-a', defaultCwd: '/a' }),
      writeProjectEnvironmentDeclaration(fs, ROOT, 'box-b', { type: 'ssh', host: 'box-b', defaultCwd: '/b' }),
      writeProjectEnvironmentDeclaration(fs, ROOT, 'box-c', { type: 'ssh', host: 'box-c', defaultCwd: '/c' }),
    ]);
    const section = await loadProjectEnvironmentsSection(fakeFs(files), ROOT);
    expect(Object.keys(section ?? {})).toEqual(expect.arrayContaining(['box-a', 'box-b', 'box-c']));
  });
});
